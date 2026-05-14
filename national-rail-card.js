class NationalRailCard extends HTMLElement {
  setConfig(config) {
    const defaults = {
      show_icon: true,
      icon: null,
      layout: "train", // train | bus
      limit: 10,
      initial_visible: 3,
      show_calling_points: false,
      show_destination: true,
      show_train_operator: true,
      show_service_status: true,
      departed_train_threshold: 1,
      minor_delay_threshold: 1,
      major_delay_threshold: 10,
      entities: [],
    };

    this.config = { ...defaults, ...config };

    if (config.entity) {
      this.config.entities.push(config.entity);
    }

    this.config.entities = this.config.entities.map(e => {
      if (typeof e === "string") {
        return { entity: e, type: null };
      }
      return e;
    });

    delete this.config.entity;
  }

  getIcon() {
    if (this.config.icon) return this.config.icon;
    return this.config.layout === "bus"
      ? "mdi:bus"
      : "mdi:train";
  }

  getMinutesAway(datetime) {
    const now = new Date();
    const t = new Date(datetime);

    if (isNaN(t)) return 0;

    return Math.max(0, Math.round((t - now) / 60000));
  }

  set hass(hass) {
    if (!this.content) {
      this.innerHTML = `<div class="nr-card"></div>`;
      this.content = this.querySelector(".nr-card");

      const style = document.createElement("style");
      style.textContent = `
        .nr-card {
          background: var(--ha-card-background, white);
          border-radius: 12px;
          box-shadow: var(--ha-card-box-shadow,0 2px 4px rgba(0,0,0,0.1));
          padding: 0 16px;
          overflow: hidden;
        }

        .status-bar {
          width: calc(100% + 32px);
          height: 10px;
          margin-left: -16px;
          margin-right: -16px;
          margin-bottom: 6px;
        }

        .status-bar.green { background:#2e7d32; }
        .status-bar.amber { background:#f9a825; }
        .status-bar.red { background:#c62828; }

        .train {
          padding: 10px 0;
          border-bottom: 1px solid #ddd;
        }

        .train:last-child {
          border-bottom: none;
        }

        .row {
          display: grid;
          grid-template-columns: 100px 1fr 80px;
        }

        .bus-row {
          display: grid;
          grid-template-columns: 40px 60px 1fr 60px;
          align-items: center;
        }

        .time {
          display: flex;
          gap: 8px;
          font-size: 1.4em;
          font-weight: bold;
        }

        .icon {
          --mdc-icon-size: 20px;
        }

        .icon.delay {
          color: #f9a825;
        }

        .icon.late {
          color: #c62828;
        }

        .destination {
          text-align: center;
          font-size: 0.85em;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .status {
          text-align: right;
          font-weight: bold;
        }

        .status.ontime {
          color: #2e7d32;
        }

        .status.delay {
          color: #f9a825;
        }

        .status.late {
          color: #c62828;
        }

        .route {
          font-weight: bold;
          text-align: center;
        }

        .minutes {
          text-align: right;
          font-weight: bold;
        }

        .operator {
          font-size: 0.8em;
          color: #666;
          text-align: center;
        }

        .operator.bus {
          text-align: left;
        }

        .calling-points {
          font-size: 0.7em;
          color: #999;
          text-align: center;
        }

        .hidden-train {
          max-height: 0;
          overflow: hidden;
          opacity: 0;
          padding: 0 !important;
          margin: 0 !important;
          border: none !important;
        }

        .train.hidden-train.expanded {
          border-bottom: 1px solid #ddd !important;
          padding: 10px 0 !important;
        }

        .train.expanded {
          max-height: 500px;
          opacity: 1;
        }

        .toggle-container {
          text-align: center;
          margin-top: 8px;
          cursor: pointer;
        }
      `;

      this.appendChild(style);
    }

    try {

      // -----------------------------
      // NORMALIZERS
      // -----------------------------
      const normalizers = {

        national_rail: (entity) => {
          if (!entity.attributes.dests) return [];

          const stationKey = Object.keys(entity.attributes.dests)[0];

          const arrivals =
            entity.attributes.dests[stationKey].Arrival?.trains || [];

          const departures =
            entity.attributes.dests[stationKey].Departure?.trains || [];

          return [...arrivals, ...departures].map(t => ({
            scheduled: t.scheduled,
            estimated: t.expected,
            destination: t.destination,
            operator: t.operator,
            callingPoints: t.callingPoints || [],
            isCancelled: t.isCancelled || false,
            route: t.platform || "",
            isDelayedText: false,
          }));
        },

        my_rail_commute: (entity) => {
          const trains = entity.attributes.all_trains || [];

          const toISO = (timeStr) => {
            if (!timeStr) return null;

            // Handle "Delayed"
            if (!timeStr.includes(":")) {
              return timeStr;
            }

            const [h, m] = timeStr.split(":").map(Number);

            const d = new Date();
            d.setHours(h, m, 0, 0);

            return d.toISOString();
          };

          return trains.map(t => ({
            scheduled: toISO(t.scheduled_departure),
            estimated: toISO(t.expected_departure),
            destination:
              t.calling_points?.slice(-1)[0] || "",
            operator: t.operator,
            callingPoints: t.calling_points || [],
            isCancelled: t.is_cancelled || false,
            isDelayedText:
              t.expected_departure === "Delayed",
            route: t.train_number || "",
          }));
        },

        tfl_bus: (entity) => {
          const departures =
            entity.attributes.departures || [];

          return departures.map(d => ({
            scheduled: d.expected,
            estimated: d.expected,
            destination: d.destination || "",
            operator: "",
            callingPoints: [],
            isCancelled: false,
            isDelayedText: false,
            route: d.line?.designation || "",
          }));
        }
      };

      // -----------------------------
      // COLLECT TRAINS
      // -----------------------------
      let allTrains = [];

      this.config.entities.forEach(e => {

        const entity = hass.states[e.entity];
        if (!entity) return;

        let normalizer = null;

        if (e.type) {
          normalizer = normalizers[e.type];

        } else if (
          e.entity.startsWith("sensor.london_tfl_")
        ) {
          normalizer = normalizers.tfl_bus;

        } else if (
          e.entity.endsWith("_summary")
        ) {
          normalizer = normalizers.my_rail_commute;

        } else if (
          e.entity.startsWith("sensor.train_schedule_")
        ) {
          normalizer = normalizers.national_rail;
        }

        if (normalizer) {
          allTrains =
            allTrains.concat(normalizer(entity));
        }
      });

      // -----------------------------
      // FILTER
      // -----------------------------
      const now = new Date();

      allTrains = allTrains.filter(t => {

        const dep =
          new Date(t.estimated || t.scheduled);

        // Allow "Delayed"
        if (isNaN(dep)) return true;

        return (
          (now - dep) / 60000 <=
          this.config.departed_train_threshold
        );
      });

      // -----------------------------
      // SORT
      // -----------------------------
      allTrains.sort((a, b) => {

        const da = new Date(a.scheduled);
        const db = new Date(b.scheduled);

        if (isNaN(da)) return 1;
        if (isNaN(db)) return -1;

        return da - db;
      });

      // -----------------------------
      // SERVICE STATUS
      // -----------------------------
      let hasMajor = false;
      let hasMinor = false;

      allTrains.forEach(t => {

        if (t.isDelayedText) {
          hasMinor = true;
          return;
        }

        const est = new Date(t.estimated);
        const sch = new Date(t.scheduled);

        if (isNaN(est) || isNaN(sch)) return;

        const delay =
          (est - sch) / 60000;

        if (
          t.isCancelled ||
          delay > this.config.major_delay_threshold
        ) {
          hasMajor = true;

        } else if (
          delay > this.config.minor_delay_threshold
        ) {
          hasMinor = true;
        }
      });

      let serviceColor = "green";

      if (hasMajor) {
        serviceColor = "red";
      } else if (hasMinor) {
        serviceColor = "amber";
      }

      // -----------------------------
      // BUILD UI
      // -----------------------------
      let html =
        (
          this.config.layout !== "bus" &&
          this.config.show_service_status
        )
          ? `<div class="status-bar ${serviceColor}"></div>`
          : `<div style="height:6px;"></div>`;

      const iconName = this.getIcon();

      allTrains
        .slice(0, this.config.limit)
        .forEach((t, index) => {

        const hiddenClass =
          index >= this.config.initial_visible
            ? "hidden-train"
            : "";

        let delay = 0;

        if (
          t.estimated &&
          !isNaN(new Date(t.estimated)) &&
          !isNaN(new Date(t.scheduled))
        ) {
          delay =
            (
              new Date(t.estimated) -
              new Date(t.scheduled)
            ) / 60000;
        }

        let statusText = "On time";
        let statusClass = "ontime";

        if (t.isCancelled) {

          statusText = "Cancelled";
          statusClass = "late";

        } else if (t.isDelayedText) {

          statusText = "Delayed";
          statusClass = "delay";

        } else if (
          delay > this.config.minor_delay_threshold
        ) {

          statusText =
            this.formatTime(t.estimated);

          statusClass =
            delay <= this.config.major_delay_threshold
              ? "delay"
              : "late";
        }

        // -----------------------------
        // TRAIN LAYOUT
        // -----------------------------
        if (this.config.layout === "train") {

          html += `
            <div class="train ${hiddenClass}">
              <div class="row">

                <div class="time">
                  ${
                    this.config.show_icon
                      ? `<ha-icon class="icon ${statusClass}" icon="${iconName}"></ha-icon>`
                      : ""
                  }

                  ${
                    this.formatTime(
                      t.scheduled
                    )
                  }
                </div>

                <div class="destination">
                  ${t.destination}
                </div>

                <div class="status ${statusClass}">
                  ${statusText}
                </div>

              </div>

              ${
                this.config.show_train_operator
                  ? `<div class="operator">${t.operator}</div>`
                  : ""
              }

              ${
                this.config.show_calling_points &&
                t.callingPoints.length
                  ? `<div class="calling-points">${t.callingPoints.join(", ")}</div>`
                  : ""
              }
            </div>
          `;
        }

        // -----------------------------
        // BUS LAYOUT
        // -----------------------------
        if (this.config.layout === "bus") {

          const mins =
            this.getMinutesAway(t.estimated);

          html += `
            <div class="train ${hiddenClass}">

              <div class="bus-row">

                <div>
                  ${
                    this.config.show_icon
                      ? `<ha-icon class="icon" icon="${iconName}"></ha-icon>`
                      : ""
                  }
                </div>

                <div class="route">
                  ${t.route}
                </div>

                <div class="destination">
                  ${t.destination}
                </div>

                <div class="minutes">
                  ${
                    mins === 0
                      ? "Due"
                      : mins + " min"
                  }
                </div>

              </div>

            </div>
          `;
        }

      });

      // -----------------------------
      // TOGGLE BUTTON
      // -----------------------------
      if (
        allTrains.length >
        this.config.initial_visible
      ) {
        html += `
          <div class="toggle-container">
            <ha-icon icon="mdi:chevron-down"></ha-icon>
          </div>
        `;
      }

      this.content.innerHTML = html;

      // -----------------------------
      // RESTORE EXPAND STATE
      // -----------------------------
      const hidden =
        this.content.querySelectorAll(
          ".hidden-train"
        );

      if (this.expanded) {
        hidden.forEach(el =>
          el.classList.add("expanded")
        );
      }

      // -----------------------------
      // TOGGLE CLICK
      // -----------------------------
      const btn =
        this.content.querySelector(
          ".toggle-container"
        );

      if (btn) {

        btn.innerHTML =
          this.expanded
            ? `<ha-icon icon="mdi:chevron-up"></ha-icon>`
            : `<ha-icon icon="mdi:chevron-down"></ha-icon>`;

        btn.onclick = () => {

          this.expanded = !this.expanded;

          hidden.forEach(el =>
            el.classList.toggle(
              "expanded",
              this.expanded
            )
          );

          btn.innerHTML =
            this.expanded
              ? `<ha-icon icon="mdi:chevron-up"></ha-icon>`
              : `<ha-icon icon="mdi:chevron-down"></ha-icon>`;
        };
      }

    } catch(e) {

      this.content.innerHTML =
        "Error parsing data";

      console.error(e);
    }
  }

  formatTime(datetime) {

    const d = new Date(datetime);

    if (isNaN(d)) {
      return datetime;
    }

    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  getCardSize() {
    return 3;
  }
}

customElements.define(
  "nr-departure-board",
  NationalRailCard
);
