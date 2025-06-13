const WebSocket = require("ws");
const fs = require("fs-extra");
const path = require("path");
const express = require("express");
const ChromecastAPI = require("chromecast-api");
const https = require("https");

let Service, Characteristic;

class RedAlertPlugin {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    // Plugin configuration with defaults
    this.name = config.name || "Red Alert";
    this.selectedCities = Array.isArray(config.cities) ? config.cities : [];
    this.alertVideoPath = config.alertVideoPath || "videos/alert.mp4";
    this.testVideoPath = config.testVideoPath || "videos/test.mp4";
    this.earlyWarningVideoPath =
      config.earlyWarningVideoPath || "videos/early.mp4";
    this.flashAlertShelterVideoPath =
      config.flashAlertShelterVideoPath || "videos/flash-shelter.mp4";

    this.chromecastVolume = Number.isFinite(config.chromecastVolume)
      ? config.chromecastVolume
      : 30;
    this.useChromecast = config.useChromecast !== false;
    this.chromecastTimeout = Number.isFinite(config.chromecastTimeout)
      ? config.chromecastTimeout
      : 30;
    this.wsUrl = config.wsUrl || "ws://ws.cumta.morhaviv.com:25565/ws";
    this.reconnectInterval = Number.isFinite(config.reconnectInterval)
      ? config.reconnectInterval
      : 5000;
    this.serverPort = Number.isFinite(config.serverPort)
      ? config.serverPort
      : 8095;
    this.baseUrl =
      config.baseUrl || `http://${this.getIpAddress()}:${this.serverPort}`;

    this.enableEarlyWarning = config.enableEarlyWarning !== false;
    this.earlyWarningStartHour = Number.isFinite(config.earlyWarningStartHour)
      ? config.earlyWarningStartHour
      : 10;
    this.earlyWarningEndHour = Number.isFinite(config.earlyWarningEndHour)
      ? config.earlyWarningEndHour
      : 20;
    this.earlyWarningVolumeReduction = Number.isFinite(
      config.earlyWarningVolumeReduction
    )
      ? config.earlyWarningVolumeReduction
      : 20;
    this.earlyWarningPollInterval = Number.isFinite(
      config.earlyWarningPollInterval
    )
      ? config.earlyWarningPollInterval
      : 8000;
    this.orefHistoryUrl =
      config.orefHistoryUrl ||
      "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json";

    // Flash alert configuration
    this.enableFlashAlerts = config.enableFlashAlerts !== false;
    this.flashAlertVolumeReduction = Number.isFinite(
      config.flashAlertVolumeReduction
    )
      ? config.flashAlertVolumeReduction
      : 10;

    // Define exact titles we're looking for
    this.EARLY_WARNING_TITLE = "בדקות הקרובות צפויות להתקבל התרעות באזורך";
    this.FLASH_SHELTER_TITLE = "שהייה בסמיכות למרחב מוגן";

    // State variables
    this.isAlertActive = false;
    this.isEarlyWarningActive = false;
    this.isFlashAlertActive = false;
    this.alertActiveCities = [];
    this.earlyWarningActiveCities = [];
    this.flashAlertActiveCities = [];
    this.wsClient = null;
    this.reconnectTimer = null;
    this.earlyWarningTimer = null;
    this.devices = [];
    this.lastEarlyWarningCheck = new Date();
    this.currentEarlyWarningPlayback = null;
    this.currentFlashAlertPlayback = null;
    this.processedEarlyWarningAlerts = new Set();
    this.processedFlashAlerts = new Set();
    this.cleanupTimer = null;

    this.validateConfig();

    if (this.api) {
      this.api.on("didFinishLaunching", () => {
        try {
          this.log.info("Initializing Red Alert plugin components...");
          this.setupMediaServer();
          if (this.useChromecast) this.setupChromecastDiscovery();
          this.setupWebSocket();
          this.copyDefaultMediaFiles();
          if (this.enableEarlyWarning || this.enableFlashAlerts)
            this.setupEarlyWarningMonitoring();
          this.setupCleanupTimer();
        } catch (error) {
          this.log.error(`Failed to initialize components: ${error.message}`);
        }
      });
    }

    // HomeKit services
    try {
      this.service = new Service.ContactSensor(this.name);
      this.testSwitchService = new Service.Switch(`${this.name} Test`, "test");
      this.testSwitchService
        .getCharacteristic(Characteristic.On)
        .on("set", this.handleTestSwitch.bind(this));
      this.earlyWarningService = new Service.ContactSensor(
        `${this.name} Early Warning`,
        "early-warning"
      );
      this.flashAlertService = new Service.ContactSensor(
        `${this.name} Flash Alert`,
        "flash-alert"
      );
    } catch (error) {
      this.log.error(`Failed to initialize HomeKit services: ${error.message}`);
    }
  }

  validateConfig() {
    try {
      if (!this.wsUrl) {
        this.log.warn("WebSocket URL missing, using default: " + this.wsUrl);
      }
      if (
        !Array.isArray(this.selectedCities) ||
        this.selectedCities.length === 0
      ) {
        this.log.warn(
          "No valid cities specified in config, monitoring all alerts"
        );
        this.selectedCities = [];
      } else {
        this.log.info(`Monitoring cities: ${this.selectedCities.join(", ")}`);
      }
      if (this.earlyWarningStartHour < 0 || this.earlyWarningStartHour > 23) {
        this.log.warn("Invalid earlyWarningStartHour, using default: 10");
        this.earlyWarningStartHour = 10;
      }
      if (this.earlyWarningEndHour < 0 || this.earlyWarningEndHour > 23) {
        this.log.warn("Invalid earlyWarningEndHour, using default: 20");
        this.earlyWarningEndHour = 20;
      }
      if (
        this.earlyWarningVolumeReduction < 0 ||
        this.earlyWarningVolumeReduction > 100
      ) {
        this.log.warn("Invalid earlyWarningVolumeReduction, using default: 20");
        this.earlyWarningVolumeReduction = 20;
      }
      if (
        this.flashAlertVolumeReduction < 0 ||
        this.flashAlertVolumeReduction > 100
      ) {
        this.log.warn("Invalid flashAlertVolumeReduction, using default: 10");
        this.flashAlertVolumeReduction = 10;
      }

      this.log.info(
        `Early warning title filter: "${this.EARLY_WARNING_TITLE}"`
      );
      this.log.info(`Flash alert title filter: "${this.FLASH_SHELTER_TITLE}"`);
    } catch (error) {
      this.log.error(`Configuration validation failed: ${error.message}`);
    }
  }

  setupCleanupTimer() {
    try {
      this.cleanupTimer = setInterval(() => {
        this.cleanupProcessedAlerts();
      }, 3600000);
    } catch (error) {
      this.log.error(`Failed to setup cleanup timer: ${error.message}`);
    }
  }

  cleanupProcessedAlerts() {
    try {
      const cutoffTime = new Date(Date.now() - 120 * 60000);
      const earlyWarningAlertsToRemove = [];
      const flashAlertsToRemove = [];
      for (const alertId of this.processedEarlyWarningAlerts) {
        try {
          const timestamp = parseInt(alertId.split("_")[0]);
          if (isNaN(timestamp) || timestamp < cutoffTime.getTime()) {
            earlyWarningAlertsToRemove.push(alertId);
          }
        } catch (error) {
          earlyWarningAlertsToRemove.push(alertId);
        }
      }
      for (const alertId of this.processedFlashAlerts) {
        try {
          const timestamp = parseInt(alertId.split("_")[0]);
          if (isNaN(timestamp) || timestamp < cutoffTime.getTime()) {
            flashAlertsToRemove.push(alertId);
          }
        } catch (error) {
          flashAlertsToRemove.push(alertId);
        }
      }
      earlyWarningAlertsToRemove.forEach((alertId) => {
        this.processedEarlyWarningAlerts.delete(alertId);
      });
      flashAlertsToRemove.forEach((alertId) => {
        this.processedFlashAlerts.delete(alertId);
      });
      if (
        earlyWarningAlertsToRemove.length > 0 ||
        flashAlertsToRemove.length > 0
      ) {
        this.log.debug(
          `Cleaned up ${earlyWarningAlertsToRemove.length} early warning and ${flashAlertsToRemove.length} flash alert processed entries`
        );
      }
    } catch (error) {
      this.log.error(`Error cleaning up processed alerts: ${error.message}`);
    }
  }

  generateAlertId(alert) {
    try {
      if (
        !alert ||
        !alert.alertDate ||
        !alert.data ||
        alert.category === undefined
      ) {
        throw new Error("Invalid alert object");
      }
      const alertDate = new Date(alert.alertDate);
      if (isNaN(alertDate.getTime())) {
        throw new Error("Invalid alert date");
      }
      const sanitizedCity = String(alert.data).replace(/[_]/g, "-");
      const titleHash = alert.title ? alert.title.substring(0, 10) : "";
      return `${alertDate.getTime()}_${sanitizedCity}_${
        alert.category
      }_${titleHash}`;
    } catch (error) {
      this.log.error(`Error generating alert ID: ${error.message}`);
      const sanitizedCity = (alert?.data || "unknown").replace(/[_]/g, "-");
      const titleHash = alert?.title ? alert.title.substring(0, 10) : "";
      return `${Date.now()}_${sanitizedCity}_${
        alert?.category || "unknown"
      }_${titleHash}`;
    }
  }

  getServices() {
    try {
      const informationService = new Service.AccessoryInformation()
        .setCharacteristic(Characteristic.Manufacturer, "Homebridge")
        .setCharacteristic(Characteristic.Model, "Red Alert")
        .setCharacteristic(Characteristic.SerialNumber, "1.0.0");

      this.service
        .getCharacteristic(Characteristic.ContactSensorState)
        .on("get", this.getAlertState.bind(this));

      this.earlyWarningService
        .getCharacteristic(Characteristic.ContactSensorState)
        .on("get", this.getEarlyWarningState.bind(this));

      this.flashAlertService
        .getCharacteristic(Characteristic.ContactSensorState)
        .on("get", this.getFlashAlertState.bind(this));

      return [
        informationService,
        this.service,
        this.testSwitchService,
        this.earlyWarningService,
        this.flashAlertService,
      ];
    } catch (error) {
      this.log.error(`Failed to expose services: ${error.message}`);
      return [];
    }
  }

  getAlertState(callback) {
    try {
      this.log.debug(`Getting alert state: ${this.isAlertActive}`);
      callback(
        null,
        this.isAlertActive
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    } catch (error) {
      this.log.error(`Error getting alert state: ${error.message}`);
      callback(error);
    }
  }

  getEarlyWarningState(callback) {
    try {
      this.log.debug(
        `Getting early warning state: ${this.isEarlyWarningActive}`
      );
      callback(
        null,
        this.isEarlyWarningActive
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    } catch (error) {
      this.log.error(`Error getting early warning state: ${error.message}`);
      callback(error);
    }
  }

  getFlashAlertState(callback) {
    try {
      this.log.debug(`Getting flash alert state: ${this.isFlashAlertActive}`);
      callback(
        null,
        this.isFlashAlertActive
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    } catch (error) {
      this.log.error(`Error getting flash alert state: ${error.message}`);
      callback(error);
    }
  }

  handleTestSwitch(on, callback) {
    try {
      if (on) {
        this.log.info("Running alert test");
        this.triggerTest();
        setTimeout(() => {
          this.testSwitchService.updateCharacteristic(Characteristic.On, false);
        }, 2000);
      }
      callback(null);
    } catch (error) {
      this.log.error(`Error handling test switch: ${error.message}`);
      callback(error);
    }
  }

  triggerTest() {
    try {
      this.isAlertActive = true;
      this.alertActiveCities =
        this.selectedCities.length > 0 ? [this.selectedCities[0]] : ["Test"];
      this.log.info(
        `Test alert triggered for: ${this.alertActiveCities.join(", ")}`
      );
      this.service.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      );
      if (this.useChromecast) {
        this.playChromecastMedia("test");
      }
      setTimeout(() => {
        this.isAlertActive = false;
        this.alertActiveCities = [];
        this.log.info("Test alert reset");
        this.service.updateCharacteristic(
          Characteristic.ContactSensorState,
          Characteristic.ContactSensorState.CONTACT_DETECTED
        );
      }, 10000);
    } catch (error) {
      this.log.error(`Error triggering test: ${error.message}`);
    }
  }

  setupEarlyWarningMonitoring() {
    try {
      this.log.info(
        `Setting up alert monitoring - Early Warning: ${this.enableEarlyWarning} (${this.earlyWarningStartHour}:00-${this.earlyWarningEndHour}:00), Flash Alerts: ${this.enableFlashAlerts} (24/7)`
      );
      this.pollEarlyWarning();
      this.earlyWarningTimer = setInterval(() => {
        this.pollEarlyWarning();
      }, this.earlyWarningPollInterval);
    } catch (error) {
      this.log.error(
        `Failed to setup early warning monitoring: ${error.message}`
      );
    }
  }

  pollEarlyWarning() {
    try {
      const options = {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.6",
          "user-agent":
            "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
          referer: "https://www.oref.org.il/eng/alerts-history",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
      };

      const req = https.get(this.orefHistoryUrl, options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            if (res.statusCode !== 200) {
              this.log.warn(`OREF API returned status: ${res.statusCode}`);
              return;
            }
            const parsedData = JSON.parse(data);
            this.processEarlyWarningData(parsedData);
            this.processFlashAlertData(parsedData);
          } catch (error) {
            this.log.error(`Error parsing alert data: ${error.message}`);
          }
        });
      });

      req.on("error", (error) => {
        this.log.error(`Alert polling request error: ${error.message}`);
      });

      req.setTimeout(10000, () => {
        req.destroy();
        this.log.warn("Alert polling request timeout");
      });
    } catch (error) {
      this.log.error(`Error polling alerts: ${error.message}`);
    }
  }

  processEarlyWarningData(alerts) {
    try {
      if (!this.enableEarlyWarning) return;
      if (!Array.isArray(alerts)) {
        this.log.warn("Invalid early warning data format - not an array");
        return;
      }
      if (alerts.length === 0) {
        this.log.debug("No alerts in response");
        return;
      }

      const now = new Date();
      const cutoffTime = new Date(now.getTime() - 60000);
      this.log.debug(
        `Processing ${
          alerts.length
        } alerts for early warnings. Current time: ${now.toISOString()}, cutoff: ${cutoffTime.toISOString()}`
      );

      // STRICT: Only category 13 with EXACT title match
      const earlyWarningAlerts = alerts.filter((alert) => {
        try {
          // Must be category 13
          if (!alert || alert.category !== 13) return false;

          // Must have exact title match
          if (!alert.title || alert.title !== this.EARLY_WARNING_TITLE) {
            if (alert.title && alert.category === 13) {
              this.log.debug(
                `Ignoring category 13 alert with non-matching title: "${alert.title}"`
              );
            }
            return false;
          }

          if (!alert.alertDate || !alert.data) {
            this.log.warn(
              `Invalid early warning alert data: ${JSON.stringify(alert)}`
            );
            return false;
          }

          const alertDate = new Date(alert.alertDate);
          if (isNaN(alertDate.getTime())) {
            this.log.warn(
              `Invalid early warning alert date: ${alert.alertDate}`
            );
            return false;
          }

          if (alertDate < cutoffTime) {
            this.log.debug(
              `Skipping old early warning alert from ${alertDate.toISOString()} (older than 60 seconds)`
            );
            return false;
          }

          const futureBuffer = new Date(now.getTime() + 10000);
          if (alertDate > futureBuffer) {
            this.log.debug(
              `Skipping future early warning alert from ${alertDate.toISOString()}`
            );
            return false;
          }

          const alertId = this.generateAlertId(alert);
          if (this.processedEarlyWarningAlerts.has(alertId)) {
            this.log.debug(`Already processed early warning: ${alertId}`);
            return false;
          }

          this.log.debug(
            `Valid early warning candidate: ${alertId} - EXACT TITLE MATCH for ${alert.data}`
          );
          return true;
        } catch (error) {
          this.log.error(
            `Error filtering early warning alert: ${error.message}`
          );
          return false;
        }
      });

      // Mark ALL matching category 13 alerts as processed
      alerts.forEach((alert) => {
        if (
          alert &&
          alert.category === 13 &&
          alert.title === this.EARLY_WARNING_TITLE
        ) {
          try {
            const alertId = this.generateAlertId(alert);
            this.processedEarlyWarningAlerts.add(alertId);
          } catch (error) {}
        }
      });

      if (earlyWarningAlerts.length === 0) {
        this.log.debug(
          "No new early warning alerts with matching titles to process"
        );
        return;
      }

      const relevantAlerts = earlyWarningAlerts.filter((alert) => {
        const isNationwide = alert.data === "ברחבי הארץ";
        const isSelectedCity =
          this.selectedCities.length === 0 ||
          this.selectedCities.includes(alert.data);
        const isRelevant = isNationwide || isSelectedCity;
        if (!isRelevant) {
          this.log.debug(
            `Skipping early warning alert for non-monitored city: ${alert.data}`
          );
        } else {
          this.log.info(
            `Early warning alert matches monitored area: ${alert.data} - EXACT TITLE MATCH`
          );
        }
        return isRelevant;
      });

      if (relevantAlerts.length === 0) {
        this.log.debug("No early warning alerts for monitored cities");
        return;
      }

      if (!this.isWithinEarlyWarningHours()) {
        this.log.info(
          `Early warning alerts for ${relevantAlerts
            .map((a) => a.data)
            .join(", ")} outside allowed hours (${
            this.earlyWarningStartHour
          }:00-${this.earlyWarningEndHour}:00)`
        );
        return;
      }

      if (this.isAlertActive) {
        this.log.info(
          `Early warning alerts for ${relevantAlerts
            .map((a) => a.data)
            .join(", ")} skipped - primary alert is active`
        );
        return;
      }

      if (this.isFlashAlertActive) {
        this.log.info(
          `Early warning alerts for ${relevantAlerts
            .map((a) => a.data)
            .join(", ")} skipped - flash alert is active`
        );
        return;
      }

      const cities = relevantAlerts.map((alert) => alert.data);
      const alertDates = relevantAlerts.map((alert) => alert.alertDate);

      this.log.info(
        `🚨 EARLY WARNING TRIGGERED for areas: ${cities.join(
          ", "
        )} (EXACT TITLE: "${
          this.EARLY_WARNING_TITLE
        }", alerts from: ${alertDates.join(", ")})`
      );
      this.triggerEarlyWarning(cities);
    } catch (error) {
      this.log.error(`Error processing early warning data: ${error.message}`);
    }
  }

  processFlashAlertData(alerts) {
    try {
      if (!this.enableFlashAlerts) return;
      if (!Array.isArray(alerts)) {
        this.log.warn("Invalid flash alert data format - not an array");
        return;
      }
      if (alerts.length === 0) {
        this.log.debug("No alerts in response for flash processing");
        return;
      }

      const now = new Date();
      const cutoffTime = new Date(now.getTime() - 60000);
      this.log.debug(
        `Processing ${
          alerts.length
        } alerts for flash alerts. Current time: ${now.toISOString()}, cutoff: ${cutoffTime.toISOString()}`
      );

      // STRICT: Only category 14 with EXACT title match for shelter alerts
      const flashAlerts = alerts.filter((alert) => {
        try {
          // Must be category 14
          if (!alert || alert.category !== 14) return false;

          // Must have exact title match for shelter
          if (!alert.title || alert.title !== this.FLASH_SHELTER_TITLE) {
            if (alert.title && alert.category === 14) {
              this.log.debug(
                `Ignoring category 14 alert with non-matching title: "${alert.title}"`
              );
            }
            return false;
          }

          if (!alert.alertDate || !alert.data) {
            this.log.warn(`Invalid flash alert data: ${JSON.stringify(alert)}`);
            return false;
          }

          const alertDate = new Date(alert.alertDate);
          if (isNaN(alertDate.getTime())) {
            this.log.warn(`Invalid flash alert date: ${alert.alertDate}`);
            return false;
          }

          if (alertDate < cutoffTime) {
            this.log.debug(
              `Skipping old flash alert from ${alertDate.toISOString()} (older than 60 seconds)`
            );
            return false;
          }

          const futureBuffer = new Date(now.getTime() + 10000);
          if (alertDate > futureBuffer) {
            this.log.debug(
              `Skipping future flash alert from ${alertDate.toISOString()}`
            );
            return false;
          }

          const alertId = this.generateAlertId(alert);
          if (this.processedFlashAlerts.has(alertId)) {
            this.log.debug(`Already processed flash alert: ${alertId}`);
            return false;
          }

          this.log.debug(
            `Valid flash alert candidate: ${alertId} - EXACT TITLE MATCH for ${alert.data}`
          );
          return true;
        } catch (error) {
          this.log.error(`Error filtering flash alert: ${error.message}`);
          return false;
        }
      });

      // Mark ALL matching category 14 alerts as processed
      alerts.forEach((alert) => {
        if (
          alert &&
          alert.category === 14 &&
          alert.title === this.FLASH_SHELTER_TITLE
        ) {
          try {
            const alertId = this.generateAlertId(alert);
            this.processedFlashAlerts.add(alertId);
          } catch (error) {}
        }
      });

      if (flashAlerts.length === 0) {
        this.log.debug("No new flash alerts with matching titles to process");
        return;
      }

      const relevantFlashAlerts = flashAlerts.filter((alert) => {
        const isNationwide = alert.data === "ברחבי הארץ";
        const isSelectedCity =
          this.selectedCities.length === 0 ||
          this.selectedCities.includes(alert.data);
        const isRelevant = isNationwide || isSelectedCity;
        if (!isRelevant) {
          this.log.debug(
            `Skipping flash alert for non-monitored city: ${alert.data}`
          );
        } else {
          this.log.info(
            `Flash alert matches monitored area: ${alert.data} - EXACT TITLE MATCH`
          );
        }
        return isRelevant;
      });

      if (relevantFlashAlerts.length === 0) {
        this.log.debug("No flash alerts for monitored cities");
        return;
      }

      if (this.isAlertActive) {
        this.log.info(
          `Flash alerts for ${relevantFlashAlerts
            .map((a) => a.data)
            .join(", ")} skipped - primary alert is active`
        );
        return;
      }

      if (this.isEarlyWarningActive) {
        this.log.info("Flash alert interrupting early warning");
        this.stopEarlyWarningPlayback();
      }

      const cities = relevantFlashAlerts.map((alert) => alert.data);
      const alertDates = relevantFlashAlerts.map((alert) => alert.alertDate);

      this.log.info(
        `⚡ FLASH ALERT TRIGGERED for areas: ${cities.join(
          ", "
        )} (EXACT TITLE: "${
          this.FLASH_SHELTER_TITLE
        }", alerts from: ${alertDates.join(", ")})`
      );
      this.triggerFlashAlert(cities);
    } catch (error) {
      this.log.error(`Error processing flash alert data: ${error.message}`);
    }
  }

  isWithinEarlyWarningHours() {
    try {
      const now = new Date();
      const currentHour = now.getHours();
      const isWithinHours =
        currentHour >= this.earlyWarningStartHour &&
        currentHour < this.earlyWarningEndHour;
      this.log.debug(
        `Time check - Current: ${currentHour}:00, Allowed: ${this.earlyWarningStartHour}:00-${this.earlyWarningEndHour}:00, Result: ${isWithinHours}`
      );
      return isWithinHours;
    } catch (error) {
      this.log.error(`Error checking early warning hours: ${error.message}`);
      return false;
    }
  }

  triggerEarlyWarning(cities) {
    try {
      if (this.currentEarlyWarningPlayback) {
        clearTimeout(this.currentEarlyWarningPlayback);
        this.currentEarlyWarningPlayback = null;
      }
      this.isEarlyWarningActive = true;
      this.earlyWarningActiveCities = cities;
      this.earlyWarningService.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      );
      if (this.useChromecast) {
        this.playChromecastMedia("early-warning");
      }
      this.currentEarlyWarningPlayback = setTimeout(() => {
        this.resetEarlyWarning();
      }, this.chromecastTimeout * 1000);
    } catch (error) {
      this.log.error(`Error triggering early warning: ${error.message}`);
    }
  }

  triggerFlashAlert(cities) {
    try {
      if (this.currentFlashAlertPlayback) {
        clearTimeout(this.currentFlashAlertPlayback);
        this.currentFlashAlertPlayback = null;
      }
      this.isFlashAlertActive = true;
      this.flashAlertActiveCities = cities;
      this.flashAlertService.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      );
      if (this.useChromecast) {
        this.playChromecastMedia("flash-shelter");
      }
      this.currentFlashAlertPlayback = setTimeout(() => {
        this.resetFlashAlert();
      }, this.chromecastTimeout * 1000);
    } catch (error) {
      this.log.error(`Error triggering flash alert: ${error.message}`);
    }
  }

  stopEarlyWarningPlayback() {
    try {
      if (this.currentEarlyWarningPlayback) {
        clearTimeout(this.currentEarlyWarningPlayback);
        this.currentEarlyWarningPlayback = null;
      }
      this.resetEarlyWarning();
    } catch (error) {
      this.log.error(`Error stopping early warning playback: ${error.message}`);
    }
  }

  stopFlashAlertPlayback() {
    try {
      if (this.currentFlashAlertPlayback) {
        clearTimeout(this.currentFlashAlertPlayback);
        this.currentFlashAlertPlayback = null;
      }
      this.resetFlashAlert();
    } catch (error) {
      this.log.error(`Error stopping flash alert playback: ${error.message}`);
    }
  }

  resetEarlyWarning() {
    try {
      if (this.isEarlyWarningActive) {
        this.log.info("Resetting early warning state");
        this.isEarlyWarningActive = false;
        this.earlyWarningActiveCities = [];
        this.earlyWarningService.updateCharacteristic(
          Characteristic.ContactSensorState,
          Characteristic.ContactSensorState.CONTACT_DETECTED
        );
      }
    } catch (error) {
      this.log.error(`Error resetting early warning: ${error.message}`);
    }
  }

  resetFlashAlert() {
    try {
      if (this.isFlashAlertActive) {
        this.log.info("Resetting flash alert state");
        this.isFlashAlertActive = false;
        this.flashAlertActiveCities = [];
        this.flashAlertService.updateCharacteristic(
          Characteristic.ContactSensorState,
          Characteristic.ContactSensorState.CONTACT_DETECTED
        );
      }
    } catch (error) {
      this.log.error(`Error resetting flash alert: ${error.message}`);
    }
  }

  setupChromecastDiscovery() {
    try {
      this.initializeChromecastClient();
      setInterval(() => {
        this.log.info("Reinitializing Chromecast client for rediscovery...");
        this.devices = [];
        this.initializeChromecastClient();
      }, 300000);
    } catch (error) {
      this.log.error(`Failed to setup Chromecast discovery: ${error.message}`);
    }
  }

  initializeChromecastClient() {
    try {
      this.chromecastClient = new ChromecastAPI();
      this.chromecastClient.on("device", (device) => {
        try {
          if (!device || !device.host || !device.friendlyName) {
            this.log.warn(
              `Invalid Chromecast device data: ${JSON.stringify(device)}`
            );
            return;
          }
          if (
            typeof device.play !== "function" ||
            typeof device.setVolume !== "function"
          ) {
            this.log.warn(
              `Chromecast '${device.friendlyName}' lacks required functions`
            );
            return;
          }
          this.log.info(
            `Chromecast discovered: ${device.friendlyName} at ${device.host}`
          );
          if (!this.devices.some((d) => d.host === device.host)) {
            this.devices.push(device);
          }
        } catch (error) {
          this.log.error(
            `Error processing Chromecast device: ${error.message}`
          );
        }
      });
      this.chromecastClient.on("error", (err) => {
        this.log.error(`ChromecastAPI error: ${err.message}`);
      });
    } catch (error) {
      this.log.error(`Failed to initialize Chromecast: ${error.message}`);
      this.useChromecast = false;
      this.devices = [];
      this.log.warn(
        "Chromecast functionality disabled due to initialization failure"
      );
    }
  }

  setupWebSocket() {
    try {
      if (this.wsClient) {
        this.wsClient.terminate();
      }
      this.log.info(`Connecting to WebSocket: ${this.wsUrl}`);
      this.wsClient = new WebSocket(this.wsUrl);
      this.wsClient.on("open", () => {
        this.log.info("WebSocket connected");
        this.log.info(
          `Monitoring cities: ${this.selectedCities.join(", ") || "all"}`
        );
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      });
      this.wsClient.on("message", (data) => {
        try {
          this.handleAlertMessage(data.toString());
        } catch (error) {
          this.log.error(
            `Error processing WebSocket message: ${error.message}`
          );
        }
      });
      this.wsClient.on("error", (error) => {
        this.log.error(`WebSocket error: ${error.message}`);
        this.scheduleReconnect();
      });
      this.wsClient.on("close", () => {
        this.log.warn("WebSocket connection closed");
        this.scheduleReconnect();
      });
      const pingInterval = setInterval(() => {
        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
          this.wsClient.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);
    } catch (error) {
      this.log.error(`Failed to setup WebSocket: ${error.message}`);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    try {
      if (!this.reconnectTimer) {
        this.log.info(
          `Scheduling WebSocket reconnect in ${
            this.reconnectInterval / 1000
          } seconds`
        );
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.setupWebSocket();
        }, this.reconnectInterval);
      }
    } catch (error) {
      this.log.error(`Error scheduling reconnect: ${error.message}`);
    }
  }

  handleAlertMessage(message) {
    try {
      let alert;
      try {
        alert = JSON.parse(message);
      } catch (parseError) {
        this.log.warn(
          `Invalid JSON in WebSocket message: ${parseError.message}`
        );
        return;
      }
      if (!alert || !alert.areas || typeof alert.areas !== "string") {
        this.log.warn("Invalid alert message format");
        return;
      }
      const areas = alert.areas
        .split(",")
        .map((s) => s.trim())
        .filter((area) => area.length > 0);

      // Accept "ברחבי הארץ" as always relevant
      const relevantAreas = areas.filter(
        (area) =>
          area === "ברחבי הארץ" ||
          this.selectedCities.length === 0 ||
          this.selectedCities.includes(area)
      );
      const isTest = alert.alert_type === 0;

      if (relevantAreas.length > 0) {
        this.log.info(
          `🚨 PRIMARY ALERT triggered for areas: ${relevantAreas.join(", ")}`
        );
        if (this.isEarlyWarningActive) {
          this.log.info("Primary alert interrupting early warning");
          this.stopEarlyWarningPlayback();
        }
        if (this.isFlashAlertActive) {
          this.log.info("Primary alert interrupting flash alert");
          this.stopFlashAlertPlayback();
        }
        this.isAlertActive = true;
        this.alertActiveCities = relevantAreas;
        this.service.updateCharacteristic(
          Characteristic.ContactSensorState,
          Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        );
        if (this.useChromecast) {
          this.playChromecastMedia(isTest ? "test" : "alert");
        }
        setTimeout(() => {
          if (this.isAlertActive) {
            this.log.info("Auto-resetting primary alert state");
            this.isAlertActive = false;
            this.alertActiveCities = [];
            this.service.updateCharacteristic(
              Characteristic.ContactSensorState,
              Characteristic.ContactSensorState.CONTACT_DETECTED
            );
          }
        }, this.chromecastTimeout * 1000);
      } else if (alert.alert_type === 255) {
        this.log.info("Received all-clear signal");
        this.isAlertActive = false;
        this.alertActiveCities = [];
        this.service.updateCharacteristic(
          Characteristic.ContactSensorState,
          Characteristic.ContactSensorState.CONTACT_DETECTED
        );
      }
    } catch (error) {
      this.log.error(`Error handling alert message: ${error.message}`);
    }
  }

  playChromecastMedia(alertType) {
    try {
      if (!this.devices.length) {
        this.log.warn("No Chromecast devices available");
        return;
      }
      const validDevices = this.devices.filter(
        (device) =>
          device &&
          typeof device.play === "function" &&
          typeof device.setVolume === "function" &&
          device.friendlyName &&
          device.host
      );
      if (!validDevices.length) {
        this.log.warn("No valid Chromecast devices available after filtering");
        return;
      }
      let mediaUrl;
      let mediaType = alertType;
      switch (alertType) {
        case "alert":
          mediaUrl = `${this.baseUrl}/alert-video`;
          break;
        case "test":
          mediaUrl = `${this.baseUrl}/test-video`;
          break;
        case "early-warning":
          mediaUrl = `${this.baseUrl}/early-warning-video`;
          break;
        case "flash-shelter":
          mediaUrl = `${this.baseUrl}/flash-shelter-video`;
          break;
        default:
          this.log.error(`Unknown alert type: ${alertType}`);
          return;
      }
      this.log.info(`Playing ${mediaType} on ${validDevices.length} devices`);
      validDevices.forEach((device) => {
        this.playWithRetry(device, mediaUrl, 3, alertType);
      });
    } catch (error) {
      this.log.error(`Error playing Chromecast media: ${error.message}`);
    }
  }

  playWithRetry(device, mediaUrl, retries, alertType) {
    try {
      this.log.debug(
        `Attempting playback on ${device.friendlyName}, host: ${device.host}`
      );
      device.play(mediaUrl, (err) => {
        if (err && retries > 0) {
          this.log.warn(
            `Retrying playback on ${device.friendlyName} (${retries} left)`
          );
          setTimeout(
            () => this.playWithRetry(device, mediaUrl, retries - 1, alertType),
            2000
          );
        } else if (err) {
          this.log.error(
            `Failed to play on ${device.friendlyName}: ${err.message}`
          );
        } else {
          this.log.info(`Playing on ${device.friendlyName}: ${mediaUrl}`);
          let baseVolume =
            this.config.chromecastVolumes?.find(
              (v) =>
                v.deviceName.toLowerCase() === device.friendlyName.toLowerCase()
            )?.volume ?? this.chromecastVolume;

          if (alertType === "early-warning") {
            baseVolume = Math.max(
              0,
              baseVolume - this.earlyWarningVolumeReduction
            );
          } else if (alertType === "flash-shelter") {
            baseVolume = Math.max(
              0,
              baseVolume - this.flashAlertVolumeReduction
            );
          }
          device.setVolume(baseVolume / 100, (err) => {
            if (err) {
              this.log.warn(
                `Failed to set volume on ${device.friendlyName}: ${err.message}`
              );
            } else {
              let volumeInfo = `Volume set to ${baseVolume}% on ${device.friendlyName}`;
              if (alertType === "early-warning") {
                volumeInfo += " (early warning reduced)";
              } else if (alertType === "flash-shelter") {
                volumeInfo += " (flash alert reduced)";
              }
              this.log.debug(volumeInfo);
            }
          });
        }
      });
    } catch (error) {
      this.log.error(
        `Synchronous error playing on ${device.friendlyName}: ${error.message}`
      );
      if (retries > 0) {
        setTimeout(
          () => this.playWithRetry(device, mediaUrl, retries - 1, alertType),
          2000
        );
      }
    }
  }

  setupMediaServer() {
    try {
      this.server = express();
      const mediaDir = path.join(
        this.api.user.storagePath(),
        "red-alert-media"
      );
      fs.ensureDirSync(mediaDir);
      this.server.use(express.static(mediaDir));
      this.server.get("/alert-video", (req, res) =>
        res.sendFile(path.join(mediaDir, this.alertVideoPath))
      );
      this.server.get("/test-video", (req, res) =>
        res.sendFile(path.join(mediaDir, this.testVideoPath))
      );
      this.server.get("/early-warning-video", (req, res) =>
        res.sendFile(path.join(mediaDir, this.earlyWarningVideoPath))
      );
      this.server.get("/flash-shelter-video", (req, res) =>
        res.sendFile(path.join(mediaDir, this.flashAlertShelterVideoPath))
      );
      this.server.get("/health", (req, res) => {
        this.log.debug("Media server health check");
        res.status(200).send("OK");
      });
      this.server
        .listen(this.serverPort, () => {
          this.log.info(`Media server running on port ${this.serverPort}`);
        })
        .on("error", (err) => {
          this.log.error(`Media server error: ${err.message}`);
        });
    } catch (error) {
      this.log.error(`Failed to setup media server: ${error.message}`);
    }
  }

  copyDefaultMediaFiles() {
    try {
      const mediaDir = path.join(
        this.api.user.storagePath(),
        "red-alert-media"
      );
      const pluginDir = path.join(__dirname, "media");
      if (fs.existsSync(pluginDir)) {
        fs.copySync(pluginDir, mediaDir, { overwrite: false });
        this.log.info("Default media files copied");
      }
    } catch (error) {
      this.log.error(`Error copying media files: ${error.message}`);
    }
  }

  getIpAddress() {
    try {
      const { networkInterfaces } = require("os");
      const nets = networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (!net.internal && net.family === "IPv4") {
            return net.address;
          }
        }
      }
      this.log.warn("No valid network interface found, using localhost");
      return "127.0.0.1";
    } catch (error) {
      this.log.error(`Error getting IP address: ${error.message}`);
      return "127.0.0.1";
    }
  }
}

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerAccessory("homebridge-red-alert", "RedAlert", RedAlertPlugin);
};
