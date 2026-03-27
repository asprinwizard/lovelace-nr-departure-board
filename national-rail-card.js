class NationalRailCard extends HTMLElement {
  setConfig(config) {
    const defaults = {
      show_icon: true,
      icon: "mdi:train",
      limit: 10,
      initial_visible: 3,
      show_calling_points: false,
      show_destination: true,
      show_train_operator: true,
      show_service_status: true,
      departed_train_threshold: 1, // minutes
      minor_delay_threshold: 1,    // minutes
      major_delay_threshold: 10,   // minutes
      entities: [],                // empty by default
    };

    // Merge defaults
    this.config = { ...defaults, ...config };

    // If single entity passed, append it to entities
    if (config.entity) {
      this.config.entities.push(config.entity);
    }

    // Normalize entities array: turn strings into objects
    this.config.entities = this.config.entities.map(e => {
      if (typeof e === "string") return { entity: e, type: null };
      return e;
    });

    delete this.config.entity; // no longer used
  }

  set hass(hass) {
    if (!this.content) {
      this.innerHTML = `<div class="card"></div>`;
      this.content = this.querySelector(".card");

      const style = document.createElement("style");
      style.textContent = `
        .card { background: var(--ha-card-background, white); border-radius:12px; box-shadow: var(--ha-card-box-shadow,0 2px 4px rgba(0,0,0,0.1)); padding:0 16px; box-sizing:border-box; overflow:hidden;}
        .status-bar { width: calc(100% + 32px); height: 10px; margin-left:-16px; margin-right:-16px; margin-bottom:6px; border-top-left-radius:12px; border-top-right-radius:12px; transition: background 0.3s ease;}
        .status-bar.green { background: #2e7d32; }
        .status-bar.amber { background: #f9a825; }
        .status-bar.red { background: #c62828; }
        .train { padding:10px 0; border-bottom:1px solid #ddd; }
        .train:last-child { border-bottom:none; }
        .row { display:grid; grid-template-columns:100px 1fr 80px; width:100%; }
        .time { display:flex; align-items:flex-start; gap:8px; font-size:1.4em; font-weight:bold; }
        .icon { font-size:20px; --mdc-icon-size:20px; margin-top:2px; }
        .icon svg { width:20px !important; height:20px !important; }
        .icon.delay { color:#f9a825; }
        .icon.late { color:#c62828; }
        .destination { text-align:center; font-size:0.85em; display:flex; align-items:center; justify-content:center; }
        .status { text-align:right; font-size:0.95em; font-weight:bold; display:flex; align-items:center; justify-content:flex-end; }
        .status.ontime { color:#2e7d32; }
        .status.delay { color:#f9a825; }
        .status.late { color:#c62828; }
        .operator { font-size:0.8em; color:#666; text-align:center; margin-top:2px; }
        .calling-points { font-size:0.7em; color:#999; text-align:center; margin-top:2px; }
        .hidden-train { max-height:0; overflow:hidden; opacity:0; padding:0 !important; margin:0 !important; border:none !important; transition: all 0.3s ease; }
        .train.hidden-train.expanded { border-bottom:1px solid #ddd !important; padding:10px 0 !important; }
        .train.expanded { max-height:500px; opacity:1; }
        .toggle-container { text-align:center; margin-top:8px; width:100%; }
        .toggle-btn { background:none; border:none; cursor:pointer; color:var(--primary-text-color); width:100%; }
      `;
      this.appendChild(style);
    }

    try {
      // --- Normalizers ---
      const normalizers = {
        national_rail: (entity) => {
          if (!entity.attributes.dests) return [];
          const stationKey = Object.keys(entity.attributes.dests)[0];
          const arrivals = entity.attributes.dests[stationKey].Arrival?.trains || [];
          const departures = entity.attributes.dests[stationKey].Departure?.trains || [];
          const trains = [...arrivals, ...departures];
          return trains.map(t => ({
            scheduled: t.scheduled,
            estimated: t.expected,
            destination: t.destination,
            operator: t.operator,
            callingPoints: t.callingPoints || [],
            isCancelled: t.isCancelled || false,
            platform: t.platform || "",
          }));
        },
        my_rail_commute: (entity) => {
          const trains = entity.attributes.all_trains || [];
        
          const today = new Date();
        
          const toISODateTime = (timeStr) => {
            if (!timeStr) return null;
          
            const [hours, minutes] = timeStr.split(":").map(Number);
          
            const d = new Date();
            d.setHours(hours, minutes, 0, 0);
          
            return d.toISOString(); // 🚫 no rollover logic
          };

        
          return trains.map(t => ({
            scheduled: toISODateTime(t.scheduled_departure),
            estimated: toISODateTime(t.expected_departure),
            destination: t.calling_points?.[t.calling_points.length - 1] || "",
            operator: t.operator,
            callingPoints: t.calling_points || [],
            isCancelled: t.is_cancelled || false,
            platform: t.platform || "",
          }));
        }
      };

      // Gather all trains from all entities
      let allTrains = [];
      this.config.entities.forEach(eidObj => {
        const entity = hass.states[eidObj.entity];
        if (!entity) return;

        let normalizer = null;
        if (eidObj.type) normalizer = normalizers[eidObj.type];
        else if (eidObj.entity.endsWith("_summary")) normalizer = normalizers.my_rail_commute;
        else if (eidObj.entity.startsWith("sensor.train_schedule_")) normalizer = normalizers.national_rail;

        if (!normalizer) return;

        allTrains = allTrains.concat(normalizer(entity));
      });

      // Filter out departed trains
      const now = new Date();
      allTrains = allTrains.filter(t => {
        const depTime = new Date(t.estimated || t.scheduled);
        return (now - depTime)/60000 <= this.config.departed_train_threshold;
      });

      // Sort by scheduled time
      allTrains.sort((a,b)=> new Date(a.scheduled)-new Date(b.scheduled));

      // Determine service status color
      let serviceColor = "green";
      allTrains.forEach(t=>{
        const delay = (new Date(t.estimated)-new Date(t.scheduled))/60000;
        if(t.isCancelled || delay>this.config.major_delay_threshold) serviceColor="red";
        else if(delay>this.config.minor_delay_threshold) serviceColor="amber";
      });

      // Build HTML
      let html = this.config.show_service_status
        ? `<div class="status-bar ${serviceColor}"></div>`
        : `<div style="height:6px;"></div>`;

      allTrains.slice(0,this.config.limit).forEach((t,index)=>{
        const scheduled = this.formatTime(t.scheduled);
        const expected = this.formatTime(t.estimated);
        const delay = (new Date(t.estimated)-new Date(t.scheduled))/60000;

        let statusText="On time", statusClass="ontime";
        if(t.isCancelled){statusText="Cancelled"; statusClass="late";}
        else if(delay>this.config.minor_delay_threshold){statusText=expected; statusClass=delay<=this.config.major_delay_threshold?"delay":"late";}

        let iconClass = statusClass==="delay"?"delay":statusClass==="late"?"late":"";

        const hiddenClass = index>=this.config.initial_visible?"hidden-train":"";

        html+=`
          <div class="train ${hiddenClass}">
            <div class="row">
              <div class="time">${this.config.show_icon?`<ha-icon class="icon ${iconClass}" icon="${this.config.icon}"></ha-icon>`:""}${scheduled}</div>
              ${this.config.show_destination?`<div class="destination">${t.destination}</div>`:"<div></div>"}
              <div class="status ${statusClass}">${statusText}</div>
            </div>
            ${this.config.show_train_operator?`<div class="operator">${t.operator}</div>`:""}
            ${this.config.show_calling_points && t.callingPoints.length?`<div class="calling-points">${t.callingPoints.join(", ")}</div>`:""}
          </div>
        `;
      });

      // Toggle button
      if(allTrains.length>this.config.initial_visible){
        html+=`<div class="toggle-container toggle-btn"><ha-icon icon="mdi:chevron-down"></ha-icon></div>`;
      }

      this.content.innerHTML = html;

      // Restore expanded state
      const hiddenTrains = this.content.querySelectorAll(".hidden-train");
      if (this.expanded) hiddenTrains.forEach(el => el.classList.add("expanded"));

      // Toggle button click
      const btn = this.content.querySelector(".toggle-btn");
      if(btn){
        this.expanded = this.expanded || false;
        btn.innerHTML = this.expanded
          ? `<ha-icon icon="mdi:chevron-up"></ha-icon>`
          : `<ha-icon icon="mdi:chevron-down"></ha-icon>`;
        btn.addEventListener("click", ()=>{
          const hiddenTrains = this.content.querySelectorAll(".hidden-train");
          this.expanded = !this.expanded;
          hiddenTrains.forEach(el => el.classList.toggle("expanded", this.expanded));
          btn.innerHTML = this.expanded
            ? `<ha-icon icon="mdi:chevron-up"></ha-icon>`
            : `<ha-icon icon="mdi:chevron-down"></ha-icon>`;
        });
      }

    } catch(e){
      this.content.innerHTML="Error parsing data";
      console.error(e);
    }
  }

  formatTime(datetime){
    const d = new Date(datetime);
    return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
  }

  getCardSize(){ return 3; }
}

customElements.define("nr-departure-board", NationalRailCard);
