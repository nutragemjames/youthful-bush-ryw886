import { useState, useEffect } from "react";
import { Calendar, momentLocalizer } from "react-big-calendar";
import moment from "moment";
import "react-big-calendar/lib/css/react-big-calendar.css";
import * as XLSX from "xlsx";
import Modal from "react-modal";
import withDragAndDrop from "react-big-calendar/lib/addons/dragAndDrop";
import "react-big-calendar/lib/addons/dragAndDrop/styles.css";

const localizer = momentLocalizer(moment);
const DnDCalendar = withDragAndDrop(Calendar);

Modal.setAppElement("#root");

const parseDateForSafari = (dateString) => {
  if (!dateString) return null;

  if (typeof dateString === "string" && dateString.includes("/")) {
    const parsedDate = moment(dateString, ["MM/DD/YYYY", "YYYY-MM-DD"], true);
    return parsedDate.isValid() ? parsedDate : null;
  }

  if (typeof dateString === "number") {
    return moment("1899-12-30").add(dateString, "days");
  }

  const momentDate = moment(dateString, ["YYYY-MM-DD", "MM/DD/YYYY"], true);
  return momentDate.isValid() ? momentDate : null;
};

const adjustToWeekday = (date) => {
  let momentDate = moment(date);
  while (momentDate.isoWeekday() > 5) {
    momentDate = momentDate.add(1, "days");
  }
  return momentDate;
};

const countBusinessDays = (start, end) => {
  let count = 0;
  let current = moment(start);
  while (current.isBefore(end) || current.isSame(end, "day")) {
    if (current.isoWeekday() <= 5) {
      count++;
    }
    current.add(1, "days");
  }
  return count;
};

const getWorkOrderColor = (station) => {
  const colorMap = {
    Blending: "#3174ad",
    Encapsulation: "#59a14f",
    Bottling: "#9c59b6",
    "Blister Pack": "#e74c3c",
    "Stick Pack": "#2c3e50",
  };
  return colorMap[station] || "#7f8c8d";
};

const WorkOrderScheduler = () => {
  const [events, setEvents] = useState([]);
  const [originalData, setOriginalData] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [isModified, setIsModified] = useState(false);
  const [workStations, setWorkStations] = useState({});
  const [view, setView] = useState("month");
  const [date, setDate] = useState(new Date());
  const [unscheduledOrders, setUnscheduledOrders] = useState([]);
  const [showUnscheduledOrders, setShowUnscheduledOrders] = useState(false);

  useEffect(() => {
    console.log("Updated events:", events);
    // Calculate workstation loading
    const stationLoading = {};
    events.forEach((event) => {
      const station = event.details["Work Station"];
      if (!stationLoading[station]) {
        stationLoading[station] = {
          totalOrders: 0,
          loadByDay: {},
          workOrdersByDay: {},
        };
      }

      stationLoading[station].totalOrders++;

      // Count load by day
      let current = moment(event.start);
      while (current.isBefore(event.end) || current.isSame(event.end, "day")) {
        if (current.isoWeekday() <= 5) {
          // Only count business days
          const dayKey = current.format("YYYY-MM-DD");
          stationLoading[station].loadByDay[dayKey] =
            (stationLoading[station].loadByDay[dayKey] || 0) + 1;

          // Track work order IDs by day
          if (!stationLoading[station].workOrdersByDay[dayKey]) {
            stationLoading[station].workOrdersByDay[dayKey] = [];
          }

          if (
            !stationLoading[station].workOrdersByDay[dayKey].includes(event.id)
          ) {
            stationLoading[station].workOrdersByDay[dayKey].push(event.id);
          }
        }
        current.add(1, "days");
      }
    });

    setWorkStations(stationLoading);
  }, [events]);

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (file) {
      console.log("File uploaded:", file.name);
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const parsedData = XLSX.utils.sheet_to_json(sheet);

        // Pre-process the work orders to handle related variants
        // E.g., ensure 10018-1 is processed before 10018
        const processedData = enhanceWorkOrderDependencies(parsedData);

        setOriginalData(processedData);
        processWorkOrders(processedData);
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const enhanceWorkOrderDependencies = (workOrders) => {
    // Create a map to easily find work orders
    const workOrderMap = {};
    workOrders.forEach((order) => {
      if (order["Work Order #"]) {
        workOrderMap[order["Work Order #"]] = order;
      }
    });

    // Find all parent-child relationships based on numbering patterns
    const enhancedOrders = [...workOrders];

    // First collect all base/variant relationships
    const baseVariantMap = {};

    enhancedOrders.forEach((order) => {
      const workOrderNum = String(order["Work Order #"]);

      // Check if this is a variant (e.g., "10018-1")
      if (workOrderNum.includes("-")) {
        const basePart = workOrderNum.split("-")[0];
        if (!baseVariantMap[basePart]) {
          baseVariantMap[basePart] = [];
        }
        baseVariantMap[basePart].push(workOrderNum);
      }
    });

    // Now set up dependencies
    Object.keys(baseVariantMap).forEach((baseNum) => {
      // Sort variants by their suffix number in descending order
      // (e.g., 10018-2 comes before 10018-1)
      const variants = baseVariantMap[baseNum].sort((a, b) => {
        const suffixA = parseInt(a.split("-")[1]);
        const suffixB = parseInt(b.split("-")[1]);
        return suffixB - suffixA;
      });

      // Set up dependency chain: base depends on variant-1, variant-1 depends on variant-2, etc.
      if (workOrderMap[baseNum]) {
        // Base work order depends on first variant
        workOrderMap[baseNum]["Dependency"] = variants[0];

        // Set up dependencies between variants if there are multiple
        for (let i = 0; i < variants.length - 1; i++) {
          if (workOrderMap[variants[i]]) {
            workOrderMap[variants[i]]["Dependency"] = variants[i + 1];
          }
        }
      }
    });

    return enhancedOrders;
  };

  const processWorkOrders = (workOrders) => {
    let scheduledEvents = [];
    let unscheduledOrders = [];
    let dependencyMap = {};
    let dependentMap = {}; // Track which work orders depend on each work order
    let today = moment().startOf("day");
    let warningMessages = [];
    let dailyWorkOrderCounts = {}; // Track work orders per day
    let dailyStationCounts = {}; // Track work orders per station per day

    // First pass - build dependency maps
    workOrders.forEach((order) => {
      if (order["Dependency"]) {
        // This order depends on another
        dependencyMap[order["Work Order #"]] = order["Dependency"];

        // The other order has this one as dependent
        if (!dependentMap[order["Dependency"]]) {
          dependentMap[order["Dependency"]] = [];
        }
        dependentMap[order["Dependency"]].push(order["Work Order #"]);
      }
    });

    console.log("Dependency Map:", dependencyMap);
    console.log("Dependent Map:", dependentMap);

    // Create a topological sort of work orders based on dependencies
    const sorted = [];
    const visited = {};
    const temp = {};

    function visit(workOrderId) {
      if (temp[workOrderId]) {
        // This means we have a cycle
        warningMessages.push(
          `Cyclic dependency detected involving Work Order #${workOrderId}`
        );
        return;
      }

      if (!visited[workOrderId]) {
        temp[workOrderId] = true;

        // Visit all dependencies first
        const dependents = dependentMap[workOrderId] || [];
        for (const dep of dependents) {
          visit(dep);
        }

        visited[workOrderId] = true;
        temp[workOrderId] = false;
        sorted.unshift(workOrderId);
      }
    }

    // Visit all nodes
    workOrders.forEach((order) => {
      if (order["Work Order #"]) {
        visit(order["Work Order #"]);
      }
    });

    console.log("Sorted work orders:", sorted);

    // Create a map of work orders for quick lookup
    const workOrderMap = {};
    workOrders.forEach((order) => {
      if (order["Work Order #"]) {
        workOrderMap[order["Work Order #"]] = order;
      }
    });

    // Schedule work orders in dependency order
    for (const workOrderId of sorted) {
      const order = workOrderMap[workOrderId];
      if (!order || order.Stage !== "Production") continue;

      let dueDate = parseDateForSafari(order["Due Date"]);

      // If this order has dependents, their start dates affect this order's due date
      const dependents = dependentMap[workOrderId] || [];
      if (dependents.length > 0) {
        // Find the earliest start date among dependents
        let earliestDependentStart = null;
        for (const depId of dependents) {
          const depOrder = workOrderMap[depId];
          if (depOrder) {
            const depDueDate = parseDateForSafari(depOrder["Due Date"]);
            if (depDueDate) {
              const depStartDate = moment(depDueDate).subtract(
                depOrder["Days to Complete"],
                "days"
              );
              if (
                !earliestDependentStart ||
                depStartDate.isBefore(earliestDependentStart)
              ) {
                earliestDependentStart = depStartDate;
              }
            }
          }
        }

        // If we found dependent dates, adjust this order's due date
        if (earliestDependentStart) {
          if (!dueDate || earliestDependentStart.isBefore(dueDate)) {
            dueDate = earliestDependentStart.toDate();
            warningMessages.push(
              `Due date for Work Order #${workOrderId} adjusted to ${moment(
                dueDate
              ).format("MM/DD/YYYY")} based on dependent work orders.`
            );
          }
        }
      }

      // If this work order depends on another, check if the dependency is scheduled
      if (dependencyMap[workOrderId]) {
        const depId = dependencyMap[workOrderId];
        const scheduledDep = scheduledEvents.find((e) => e.id === depId);

        if (scheduledDep) {
          // The dependency is scheduled, this order can't start until dependency is complete
          const depEndDate = moment(scheduledDep.end);
          const startDate = moment(depEndDate).add(1, "days"); // Start the day after dependency completes

          if (!dueDate) {
            dueDate = moment(startDate)
              .add(order["Days to Complete"], "business_days")
              .toDate();
          } else if (
            startDate.isAfter(
              moment(dueDate).subtract(order["Days to Complete"], "days")
            )
          ) {
            // Dependency pushes this start date too late to meet original due date
            const newDueDate = moment(startDate)
              .add(order["Days to Complete"], "business_days")
              .toDate();
            warningMessages.push(
              `Work Order #${workOrderId} will be late due to dependency on Work Order #${depId}. Original due: ${moment(
                dueDate
              ).format("MM/DD/YYYY")}, New completion: ${moment(
                newDueDate
              ).format("MM/DD/YYYY")}.`
            );
            dueDate = newDueDate;
          }
        } else {
          // The dependency is not scheduled yet or not found
          warningMessages.push(
            `Work Order #${workOrderId} depends on Work Order #${depId} which is not scheduled.`
          );

          // Track this as an unscheduled order
          unscheduledOrders.push({
            id: workOrderId,
            details: order,
            dependency: depId,
            reason: `Depends on unscheduled Work Order #${depId}`,
          });

          // Skip scheduling this order until its dependency is scheduled
          continue;
        }
      }

      if (!dueDate) {
        warningMessages.push(`Invalid due date for Work Order #${workOrderId}`);

        // Track this as an unscheduled order
        unscheduledOrders.push({
          id: workOrderId,
          details: order,
          reason: "Invalid due date",
        });

        continue;
      }

      // Calculate ideal start date
      let startDate = moment(dueDate).subtract(
        order["Days to Complete"],
        "days"
      );
      let willBeLate = false;

      // If start date is in the past, start today
      if (startDate.isBefore(today)) {
        startDate = moment(today);

        // Check if we can complete on time
        if (countBusinessDays(startDate, dueDate) < order["Days to Complete"]) {
          // Calculate new completion date based on days to complete
          const estimatedEndDate = moment(startDate).add(
            order["Days to Complete"],
            "business_days"
          );
          willBeLate = true;
          warningMessages.push(
            `Warning: Work Order #${workOrderId} will be completed late. Due: ${moment(
              dueDate
            ).format(
              "MM/DD/YYYY"
            )}, Estimated completion: ${estimatedEndDate.format("MM/DD/YYYY")}.`
          );
          // Use the estimated completion date instead of the original due date
          dueDate = estimatedEndDate;
        }
      }

      // Ensure work doesn't start on weekends
      startDate = adjustToWeekday(startDate);

      // Check for conflicts and adjust schedule if needed
      let hasConflict = false;
      let attemptedReschedule = false;
      let conflictMessage = "";

      // First try the original dates
      const workStation = order["Work Station"];

      // Check each day in the work order duration for conflicts
      let currentDate = moment(startDate);
      while (currentDate.isSameOrBefore(dueDate, "day")) {
        if (currentDate.isoWeekday() <= 5) {
          // Only check business days
          const dateStr = currentDate.format("YYYY-MM-DD");

          // Initialize tracking objects if needed
          if (!dailyWorkOrderCounts[dateStr]) dailyWorkOrderCounts[dateStr] = 0;
          if (!dailyStationCounts[dateStr]) dailyStationCounts[dateStr] = {};
          if (!dailyStationCounts[dateStr][workStation])
            dailyStationCounts[dateStr][workStation] = 0;

          // Check same station conflict
          if (dailyStationCounts[dateStr][workStation] > 0) {
            hasConflict = true;
            conflictMessage = `Same station conflict for Work Order #${workOrderId} (${workStation}) on ${dateStr}`;
            break;
          }

          // Check daily limit conflict
          if (dailyWorkOrderCounts[dateStr] >= 2) {
            hasConflict = true;
            conflictMessage = `Daily limit exceeded for Work Order #${workOrderId} on ${dateStr}`;
            break;
          }
        }
        currentDate.add(1, "day");
      }

      // If conflicts exist, try to find a new start date
      if (hasConflict) {
        // Try to find the next available slot
        let newStartDate = moment(dueDate).subtract(
          order["Days to Complete"],
          "days"
        );
        let daysToShift = 1;
        const maxAttempts = 20; // Limit how far we look ahead

        while (daysToShift <= maxAttempts) {
          newStartDate = moment(startDate).add(daysToShift, "days");
          const newEndDate = moment(newStartDate).add(
            order["Days to Complete"],
            "business_days"
          );

          // Check if this would push completion past due date
          if (newEndDate.isAfter(dueDate) && !willBeLate) {
            // If it would make it late, recalculate end date and mark as late
            dueDate = newEndDate;
            willBeLate = true;
            warningMessages.push(
              `Warning: Work Order #${workOrderId} rescheduled to avoid conflicts and will be late. Original due: ${moment(
                parseDateForSafari(order["Due Date"])
              ).format("MM/DD/YYYY")}, New completion: ${dueDate.format(
                "MM/DD/YYYY"
              )}.`
            );
          }

          // Check if this new slot works
          hasConflict = false;
          currentDate = moment(newStartDate);

          while (currentDate.isSameOrBefore(newEndDate, "day")) {
            if (currentDate.isoWeekday() <= 5) {
              // Only check business days
              const dateStr = currentDate.format("YYYY-MM-DD");

              // Initialize tracking if needed
              if (!dailyWorkOrderCounts[dateStr])
                dailyWorkOrderCounts[dateStr] = 0;
              if (!dailyStationCounts[dateStr])
                dailyStationCounts[dateStr] = {};
              if (!dailyStationCounts[dateStr][workStation])
                dailyStationCounts[dateStr][workStation] = 0;

              // Check same station conflict
              if (dailyStationCounts[dateStr][workStation] > 0) {
                hasConflict = true;
                break;
              }

              // Check daily limit conflict
              if (dailyWorkOrderCounts[dateStr] >= 2) {
                hasConflict = true;
                break;
              }
            }
            currentDate.add(1, "day");
          }

          if (!hasConflict) {
            // Found a good slot!
            startDate = newStartDate.toDate();
            dueDate = newEndDate.toDate();
            attemptedReschedule = true;
            break;
          }

          daysToShift++;
        }

        if (hasConflict && !attemptedReschedule) {
          warningMessages.push(
            `${conflictMessage}. Work order has been scheduled despite conflicts.`
          );
        } else if (attemptedReschedule && !willBeLate) {
          warningMessages.push(
            `Work Order #${workOrderId} rescheduled to avoid conflicts.`
          );
        }
      }

      // Update tracking counts for final schedule
      currentDate = moment(startDate);
      while (currentDate.isSameOrBefore(dueDate, "day")) {
        if (currentDate.isoWeekday() <= 5) {
          // Only count business days
          const dateStr = currentDate.format("YYYY-MM-DD");

          // Initialize if needed
          if (!dailyWorkOrderCounts[dateStr]) dailyWorkOrderCounts[dateStr] = 0;
          if (!dailyStationCounts[dateStr]) dailyStationCounts[dateStr] = {};
          if (!dailyStationCounts[dateStr][workStation])
            dailyStationCounts[dateStr][workStation] = 0;

          // Increment counts
          dailyWorkOrderCounts[dateStr]++;
          dailyStationCounts[dateStr][workStation]++;
        }
        currentDate.add(1, "day");
      }

      // Determine if work order will be late
      const originalDueDate = parseDateForSafari(order["Due Date"]);
      const isLate = moment(dueDate).isAfter(originalDueDate);

      let event = {
        id: workOrderId,
        title: `WO ${workOrderId} - ${workStation}`,
        start: moment(startDate).toDate(),
        end: moment(dueDate).toDate(),
        details: {
          ...order,
          "Is Late": isLate,
          "Original Due Date": originalDueDate
            ? moment(originalDueDate).format("MM/DD/YYYY")
            : null,
        },
        style: {
          backgroundColor: getWorkOrderColor(workStation),
          border: isLate ? "2px dashed red" : undefined,
          boxShadow: isLate ? "0 0 5px rgba(255,0,0,0.5)" : undefined,
        },
      };
      scheduledEvents.push(event);
    }

    setEvents(scheduledEvents);
    setWarnings(warningMessages);
    setUnscheduledOrders(unscheduledOrders);
    setIsModified(false);
  };

  const handleEventDrop = ({ event, start, end }) => {
    // Calculate new end date based on the days to complete
    const daysToComplete = event.details["Days to Complete"];
    const newEnd = moment(start).add(daysToComplete, "business_days").toDate();

    // Check for scheduling conflicts
    const conflictWarnings = checkSchedulingConflicts(
      event.id,
      start,
      newEnd,
      event.details["Work Station"]
    );

    if (conflictWarnings.length > 0) {
      setWarnings([...warnings, ...conflictWarnings]);
      return; // Don't update if there are conflicts
    }

    // Check if the work order will be late
    const originalDueDate = event.details["Original Due Date"]
      ? moment(event.details["Original Due Date"], "MM/DD/YYYY")
      : parseDateForSafari(event.details["Due Date"]);

    const isLate = moment(newEnd).isAfter(originalDueDate);

    const updatedEvents = events.map((existingEvent) => {
      if (existingEvent.id === event.id) {
        return {
          ...existingEvent,
          start,
          end: newEnd,
          details: {
            ...existingEvent.details,
            "Is Late": isLate,
            "Adjusted Due Date": moment(newEnd).format("MM/DD/YYYY"),
          },
          style: {
            backgroundColor: getWorkOrderColor(
              existingEvent.details["Work Station"]
            ),
            border: isLate ? "2px dashed red" : undefined,
            boxShadow: isLate ? "0 0 5px rgba(255,0,0,0.5)" : undefined,
          },
        };
      }
      return existingEvent;
    });

    // Check for any dependencies that need to be updated
    const dependentEvents = events.filter(
      (e) => e.details["Dependency"] === event.id
    );

    if (dependentEvents.length > 0) {
      // Create a warning that dependent events may need to be rescheduled
      setWarnings([
        ...warnings,
        `Work Order #${event.id} was moved. ${dependentEvents.length} dependent work orders may need to be rescheduled.`,
      ]);
    }

    // Add warning if work order will be late
    if (isLate && !event.details["Is Late"]) {
      setWarnings([
        ...warnings,
        `Work Order #${event.id} is now scheduled to complete after its due date.`,
      ]);
    } else if (!isLate && event.details["Is Late"]) {
      setWarnings([
        ...warnings,
        `Work Order #${event.id} is now scheduled to complete on time.`,
      ]);
    }

    setEvents(updatedEvents);
    setIsModified(true);
  };

  const checkSchedulingConflicts = (
    currentEventId,
    startDate,
    endDate,
    workStation
  ) => {
    const conflicts = [];

    // Loop through all business days in the range
    let currentDay = moment(startDate);
    const lastDay = moment(endDate);

    while (currentDay.isSameOrBefore(lastDay, "day")) {
      if (currentDay.isoWeekday() <= 5) {
        // Only check business days
        const dayStr = currentDay.format("YYYY-MM-DD");

        // Count all orders (including the current one) scheduled on this day
        const ordersOnDay = events.filter(
          (e) =>
            e.id !== currentEventId && // Exclude the current event being checked
            moment(e.start).isSameOrBefore(currentDay, "day") &&
            moment(e.end).isSameOrAfter(currentDay, "day")
        );

        // Check for same work station conflicts
        const sameStationOrders = ordersOnDay.filter(
          (e) => e.details["Work Station"] === workStation
        );

        if (sameStationOrders.length > 0) {
          conflicts.push(
            `Conflict on ${currentDay.format(
              "MM/DD/YYYY"
            )}: Another ${workStation} work order is already scheduled (WO #${
              sameStationOrders[0].id
            }).`
          );
        }

        // Check for overall daily limit (2 orders per day)
        if (ordersOnDay.length >= 2) {
          conflicts.push(
            `Conflict on ${currentDay.format(
              "MM/DD/YYYY"
            )}: Daily limit of 2 work orders exceeded.`
          );
          break; // No need to check further days if we already have a conflict
        }
      }

      currentDay.add(1, "day");
    }

    return conflicts;
  };

  const forceScheduleWorkOrder = (workOrderId) => {
    const orderToSchedule = unscheduledOrders.find(
      (order) => order.id === workOrderId
    );
    if (!orderToSchedule) return;

    const order = orderToSchedule.details;
    const dueDate =
      parseDateForSafari(order["Due Date"]) ||
      moment()
        .add(order["Days to Complete"] || 1, "business_days")
        .toDate();
    let startDate = moment(dueDate).subtract(
      order["Days to Complete"] || 1,
      "days"
    );

    // Ensure work doesn't start in the past
    if (startDate.isBefore(moment().startOf("day"))) {
      startDate = moment().startOf("day");
    }

    // Ensure work doesn't start on weekends
    startDate = adjustToWeekday(startDate);

    const willBeLate = moment(startDate)
      .add(order["Days to Complete"], "business_days")
      .isAfter(dueDate);

    const originalDueDate = parseDateForSafari(order["Due Date"]);
    const actualEndDate = moment(startDate)
      .add(order["Days to Complete"], "business_days")
      .toDate();

    const event = {
      id: workOrderId,
      title: `WO ${workOrderId} - ${order["Work Station"]}`,
      start: startDate.toDate(),
      end: actualEndDate,
      details: {
        ...order,
        "Is Late": willBeLate,
        "Original Due Date": originalDueDate
          ? moment(originalDueDate).format("MM/DD/YYYY")
          : null,
        "Force Scheduled": true,
      },
      style: {
        backgroundColor: getWorkOrderColor(order["Work Station"]),
        border: willBeLate ? "2px dashed red" : "2px solid #28a745",
        boxShadow: willBeLate
          ? "0 0 5px rgba(255,0,0,0.5)"
          : "0 0 5px rgba(40,167,69,0.5)",
      },
    };

    setEvents([...events, event]);
    setUnscheduledOrders(unscheduledOrders.filter((o) => o.id !== workOrderId));
    setIsModified(true);
    setWarnings([
      ...warnings,
      `Work Order #${workOrderId} has been force scheduled. Dependencies may be affected.`,
    ]);
  };

  const exportSchedule = () => {
    // Convert events back to Excel format
    const exportData = events.map((event) => {
      return {
        "Work Order #": event.id,
        "Work Station": event.details["Work Station"],
        "Start Date": moment(event.start).format("MM/DD/YYYY"),
        "Due Date": moment(event.end).format("MM/DD/YYYY"),
        "Days to Complete": event.details["Days to Complete"],
        Dependency: event.details["Dependency"] || "",
        Adjusted:
          moment(event.end).format("MM/DD/YYYY") !==
          moment(parseDateForSafari(event.details["Due Date"])).format(
            "MM/DD/YYYY"
          )
            ? "Yes"
            : "No",
      };
    });

    // Create worksheet
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Updated Schedule");

    // Create download
    XLSX.writeFile(wb, "updated_work_orders.xlsx");
  };

  return (
    <div style={{ height: "90vh", padding: "20px", position: "relative" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "20px",
        }}
      >
        <h2>Work Order Scheduler</h2>
        <div>
          <input
            type="file"
            accept=".xlsx, .xls"
            onChange={handleFileUpload}
            style={{ marginRight: "10px" }}
          />
          <button
            onClick={exportSchedule}
            disabled={!isModified}
            style={{
              padding: "8px 16px",
              backgroundColor: isModified ? "#4CAF50" : "#cccccc",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: isModified ? "pointer" : "default",
            }}
          >
            Export Schedule
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div
          style={{
            backgroundColor: "#fff3cd",
            padding: "10px",
            margin: "10px 0",
            border: "1px solid #ffeeba",
            borderRadius: "4px",
            maxHeight: "200px",
            overflowY: "auto",
          }}
        >
          <h4 style={{ color: "#856404", marginTop: 0 }}>
            Scheduling Warnings: ({warnings.length})
          </h4>

          {/* Group warnings by type */}
          <div style={{ marginBottom: "10px" }}>
            <strong>Dependency Issues:</strong>
            <ul style={{ margin: 0 }}>
              {warnings
                .filter(
                  (w) => w.includes("depends on") || w.includes("dependency")
                )
                .map((warning, index) => (
                  <li key={`dep-${index}`}>{warning}</li>
                ))}
            </ul>
          </div>

          <div style={{ marginBottom: "10px" }}>
            <strong>Scheduling Conflicts:</strong>
            <ul style={{ margin: 0 }}>
              {warnings
                .filter(
                  (w) => w.includes("conflict") || w.includes("reschedule")
                )
                .map((warning, index) => (
                  <li key={`conflict-${index}`}>{warning}</li>
                ))}
            </ul>
          </div>

          <div style={{ marginBottom: "10px" }}>
            <strong>Due Date Issues:</strong>
            <ul style={{ margin: 0 }}>
              {warnings
                .filter((w) => w.includes("due date") || w.includes("late"))
                .map((warning, index) => (
                  <li key={`due-${index}`}>{warning}</li>
                ))}
            </ul>
          </div>

          <div>
            <strong>Other Warnings:</strong>
            <ul style={{ margin: 0 }}>
              {warnings
                .filter(
                  (w) =>
                    !w.includes("depends on") &&
                    !w.includes("dependency") &&
                    !w.includes("conflict") &&
                    !w.includes("reschedule") &&
                    !w.includes("due date") &&
                    !w.includes("late")
                )
                .map((warning, index) => (
                  <li key={`other-${index}`}>{warning}</li>
                ))}
            </ul>
          </div>

          <button
            onClick={() => setWarnings([])}
            style={{
              marginTop: "8px",
              padding: "4px 8px",
              backgroundColor: "transparent",
              border: "1px solid #856404",
              borderRadius: "4px",
              color: "#856404",
              cursor: "pointer",
            }}
          >
            Clear Warnings
          </button>
        </div>
      )}

      {unscheduledOrders.length > 0 && (
        <div style={{ marginBottom: "10px" }}>
          <button
            onClick={() => setShowUnscheduledOrders(!showUnscheduledOrders)}
            style={{
              padding: "8px 12px",
              backgroundColor: "#dc3545",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
            }}
          >
            <span style={{ marginRight: "8px" }}>
              {showUnscheduledOrders ? "Hide" : "Show"} Unscheduled Orders (
              {unscheduledOrders.length})
            </span>
            <span style={{ fontSize: "10px" }}>
              {showUnscheduledOrders ? "▲" : "▼"}
            </span>
          </button>

          {showUnscheduledOrders && (
            <div
              style={{
                backgroundColor: "#f8d7da",
                padding: "15px",
                marginTop: "10px",
                border: "1px solid #f5c6cb",
                borderRadius: "4px",
              }}
            >
              <h4 style={{ color: "#721c24", marginTop: 0 }}>
                Unscheduled Work Orders
              </h4>

              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #dee2e6" }}>
                    <th style={{ textAlign: "left", padding: "8px" }}>
                      Work Order #
                    </th>
                    <th style={{ textAlign: "left", padding: "8px" }}>
                      Work Station
                    </th>
                    <th style={{ textAlign: "left", padding: "8px" }}>
                      Reason
                    </th>
                    <th style={{ textAlign: "left", padding: "8px" }}>
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {unscheduledOrders.map((order) => (
                    <tr
                      key={order.id}
                      style={{ borderBottom: "1px solid #dee2e6" }}
                    >
                      <td style={{ padding: "8px" }}>{order.id}</td>
                      <td style={{ padding: "8px" }}>
                        {order.details["Work Station"]}
                      </td>
                      <td style={{ padding: "8px" }}>{order.reason}</td>
                      <td style={{ padding: "8px" }}>
                        <button
                          onClick={() => forceScheduleWorkOrder(order.id)}
                          style={{
                            padding: "4px 8px",
                            backgroundColor: "#28a745",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                            fontSize: "0.8rem",
                          }}
                        >
                          Force Schedule
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", height: "calc(100% - 150px)" }}>
        <div style={{ width: "80%", height: "100%" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "10px",
              alignItems: "center",
            }}
          >
            <div>
              <button
                onClick={() => setView("month")}
                style={{
                  padding: "6px 12px",
                  backgroundColor: view === "month" ? "#007bff" : "#f8f9fa",
                  color: view === "month" ? "white" : "#212529",
                  border: "1px solid #dee2e6",
                  borderRadius: "4px 0 0 4px",
                  cursor: "pointer",
                }}
              >
                Month
              </button>
              <button
                onClick={() => setView("week")}
                style={{
                  padding: "6px 12px",
                  backgroundColor: view === "week" ? "#007bff" : "#f8f9fa",
                  color: view === "week" ? "white" : "#212529",
                  border: "1px solid #dee2e6",
                  borderLeft: "none",
                  cursor: "pointer",
                }}
              >
                Week
              </button>
              <button
                onClick={() => setView("day")}
                style={{
                  padding: "6px 12px",
                  backgroundColor: view === "day" ? "#007bff" : "#f8f9fa",
                  color: view === "day" ? "white" : "#212529",
                  border: "1px solid #dee2e6",
                  borderLeft: "none",
                  cursor: "pointer",
                }}
              >
                Day
              </button>
              <button
                onClick={() => setView("agenda")}
                style={{
                  padding: "6px 12px",
                  backgroundColor: view === "agenda" ? "#007bff" : "#f8f9fa",
                  color: view === "agenda" ? "white" : "#212529",
                  border: "1px solid #dee2e6",
                  borderLeft: "none",
                  borderRadius: "0 4px 4px 0",
                  cursor: "pointer",
                }}
              >
                Agenda
              </button>
            </div>
            <div>
              <button
                onClick={() => {
                  const newDate = moment(date).subtract(1, view).toDate();
                  setDate(newDate);
                }}
                style={{
                  padding: "6px 12px",
                  backgroundColor: "#f8f9fa",
                  border: "1px solid #dee2e6",
                  borderRadius: "4px 0 0 4px",
                  cursor: "pointer",
                }}
              >
                &lt;
              </button>
              <button
                onClick={() => setDate(new Date())}
                style={{
                  padding: "6px 12px",
                  backgroundColor: "#f8f9fa",
                  border: "1px solid #dee2e6",
                  borderLeft: "none",
                  cursor: "pointer",
                }}
              >
                Today
              </button>
              <button
                onClick={() => {
                  const newDate = moment(date).add(1, view).toDate();
                  setDate(newDate);
                }}
                style={{
                  padding: "6px 12px",
                  backgroundColor: "#f8f9fa",
                  border: "1px solid #dee2e6",
                  borderLeft: "none",
                  borderRadius: "0 4px 4px 0",
                  cursor: "pointer",
                }}
              >
                &gt;
              </button>
            </div>
          </div>
          <DnDCalendar
            localizer={localizer}
            events={events}
            startAccessor="start"
            endAccessor="end"
            style={{
              height: "calc(100% - 40px)",
              position: "relative",
              zIndex: 1,
            }}
            popup
            tooltipAccessor={(event) =>
              `${event.title}\nStart: ${moment(event.start).format(
                "MM/DD/YYYY"
              )}\nDue: ${moment(event.end).format("MM/DD/YYYY")}`
            }
            eventPropGetter={(event) => ({ style: event.style })}
            onEventDrop={handleEventDrop}
            onSelectEvent={(event) => setSelectedEvent(event)}
            resizable={false}
            view={view}
            onView={setView}
            date={date}
            onNavigate={setDate}
            toolbar={false}
            components={{
              dateCellWrapper: (props) => {
                const dateStr = moment(props.value).format("YYYY-MM-DD");

                // Count work orders on this day
                const ordersOnDay = events.filter(
                  (event) =>
                    moment(event.start).isSameOrBefore(props.value, "day") &&
                    moment(event.end).isSameOrAfter(props.value, "day")
                );

                // Count unique work stations for this day
                const workStationsOnDay = new Set(
                  ordersOnDay.map((event) => event.details["Work Station"])
                );

                // Check for conflicts
                const hasStationConflict =
                  workStationsOnDay.size < ordersOnDay.length;
                const hasDailyLimitConflict = ordersOnDay.length > 2;

                let conflictStyle = {};
                if (hasStationConflict || hasDailyLimitConflict) {
                  conflictStyle = {
                    backgroundColor: "rgba(255, 0, 0, 0.15)",
                    border: "1px dashed red",
                  };
                } else if (ordersOnDay.length === 2) {
                  // At capacity but no conflict
                  conflictStyle = {
                    backgroundColor: "rgba(255, 165, 0, 0.15)",
                    border: "1px solid orange",
                  };
                }

                return (
                  <div
                    style={{
                      ...props.style,
                      ...conflictStyle,
                      height: "100%",
                      position: "relative",
                    }}
                  >
                    {props.children}
                    {ordersOnDay.length > 0 && (
                      <div
                        style={{
                          position: "absolute",
                          bottom: "2px",
                          right: "2px",
                          fontSize: "10px",
                          padding: "2px 4px",
                          backgroundColor:
                            ordersOnDay.length > 2
                              ? "red"
                              : ordersOnDay.length === 2
                              ? "orange"
                              : "green",
                          color: "white",
                          borderRadius: "50%",
                          width: "16px",
                          height: "16px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {ordersOnDay.length}
                      </div>
                    )}
                  </div>
                );
              },
            }}
          />
        </div>

        <div style={{ width: "20%", marginLeft: "20px", overflowY: "auto" }}>
          <h3>Workstation Load</h3>
          {Object.keys(workStations).map((station) => (
            <div key={station} style={{ marginBottom: "15px" }}>
              <h4
                style={{
                  backgroundColor: getWorkOrderColor(station),
                  color: "white",
                  padding: "5px 10px",
                  borderRadius: "4px",
                  margin: "5px 0",
                }}
              >
                {station}: {workStations[station].totalOrders} orders
              </h4>
              <div style={{ fontSize: "0.85em" }}>
                <p>
                  <strong>Daily Load:</strong>
                </p>
                {Object.keys(workStations[station].loadByDay)
                  .sort()
                  .slice(0, 5)
                  .map((day) => (
                    <div
                      key={day}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "2px 0",
                      }}
                    >
                      <span>{moment(day).format("MM/DD")}</span>
                      <div>
                        {workStations[station].workOrdersByDay[day] &&
                          workStations[station].workOrdersByDay[day].map(
                            (woId, idx) => (
                              <span
                                key={idx}
                                style={{
                                  marginLeft: idx > 0 ? "4px" : "0",
                                  fontWeight: "500",
                                  display: "inline-block",
                                }}
                              >
                                {woId}
                                {idx <
                                workStations[station].workOrdersByDay[day]
                                  .length -
                                  1
                                  ? ","
                                  : ""}
                              </span>
                            )
                          )}
                      </div>
                    </div>
                  ))}
                {Object.keys(workStations[station].loadByDay).length > 5 && (
                  <p style={{ fontStyle: "italic" }}>
                    + {Object.keys(workStations[station].loadByDay).length - 5}{" "}
                    more days
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      {selectedEvent && (
        <Modal
          isOpen={true}
          onRequestClose={() => setSelectedEvent(null)}
          contentLabel="Work Order Details"
          style={{
            content: {
              top: "50%",
              left: "50%",
              right: "auto",
              bottom: "auto",
              marginRight: "-50%",
              transform: "translate(-50%, -50%)",
              padding: "20px",
              borderRadius: "8px",
              maxWidth: "500px",
              width: "90%",
            },
            overlay: {
              backgroundColor: "rgba(0, 0, 0, 0.5)",
              zIndex: 1000,
            },
          }}
        >
          <h2 style={{ borderBottom: "1px solid #eee", paddingBottom: "10px" }}>
            Work Order Details
          </h2>
          <div style={{ marginBottom: "20px" }}>
            <p>
              <strong>Work Order #:</strong> {selectedEvent.id}
            </p>
            <p>
              <strong>Work Station:</strong>{" "}
              {selectedEvent.details["Work Station"]}
            </p>
            <p>
              <strong>Scheduled Start:</strong>{" "}
              {moment(selectedEvent.start).format("MM/DD/YYYY")}
            </p>
            <p>
              <strong>Completion Date:</strong>{" "}
              {moment(selectedEvent.end).format("MM/DD/YYYY")}
            </p>

            {selectedEvent.details["Is Late"] && (
              <p style={{ color: "red" }}>
                <strong>Original Due Date:</strong>{" "}
                {selectedEvent.details["Original Due Date"]}
                <span
                  style={{
                    marginLeft: "10px",
                    backgroundColor: "#ffecec",
                    padding: "2px 6px",
                    borderRadius: "3px",
                  }}
                >
                  LATE
                </span>
              </p>
            )}

            <p>
              <strong>Days to Complete:</strong>{" "}
              {selectedEvent.details["Days to Complete"]}
            </p>
            {selectedEvent.details["Dependency"] && (
              <p>
                <strong>Depends on:</strong> Work Order #
                {selectedEvent.details["Dependency"]}
              </p>
            )}

            {/* Display additional details if available */}
            {selectedEvent.details["Customer"] && (
              <p>
                <strong>Customer:</strong> {selectedEvent.details["Customer"]}
              </p>
            )}
            {selectedEvent.details["Quantity"] && (
              <p>
                <strong>Quantity:</strong> {selectedEvent.details["Quantity"]}
              </p>
            )}
            {selectedEvent.details["Notes"] && (
              <div>
                <strong>Notes:</strong>
                <p
                  style={{
                    backgroundColor: "#f9f9f9",
                    padding: "8px",
                    borderRadius: "4px",
                  }}
                >
                  {selectedEvent.details["Notes"]}
                </p>
              </div>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <button
              onClick={() => setSelectedEvent(null)}
              style={{
                padding: "8px 16px",
                backgroundColor: "#6c757d",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              Close
            </button>

            <button
              onClick={() => {
                // Find dependent work orders that might be affected
                const dependentEvents = events.filter(
                  (e) => e.details["Dependency"] === selectedEvent.id
                );

                // Show confirmation dialog
                if (dependentEvents.length > 0) {
                  if (
                    window.confirm(
                      `This work order has ${dependentEvents.length} dependent work orders. Are you sure you want to remove it?`
                    )
                  ) {
                    setEvents(events.filter((e) => e.id !== selectedEvent.id));
                    setSelectedEvent(null);
                    setIsModified(true);
                    setWarnings([
                      ...warnings,
                      `Work Order #${selectedEvent.id} removed. Dependent work orders may need to be rescheduled.`,
                    ]);
                  }
                } else {
                  setEvents(events.filter((e) => e.id !== selectedEvent.id));
                  setSelectedEvent(null);
                  setIsModified(true);
                }
              }}
              style={{
                padding: "8px 16px",
                backgroundColor: "#dc3545",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              Remove Work Order
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default WorkOrderScheduler;
