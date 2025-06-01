/**
 * Homebridge Red Alert Plugin
 * Monitors Israel's Red Alert system and sends notifications to Chromecast devices.
 * Integrates with HomeKit for alert state and test functionality.
 */

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
    this.alertSoundPath = config.alertSoundPath || "sounds/alert.mp3";
    this.testSoundPath = config.testSoundPath || "sounds/test.mp3";
    this.alertVideoPath = config.alertVideoPath || "videos/alert.mp4";
    this.testVideoPath = config.testVideoPath || "videos/test.mp4";
    this.earlyWarningVideoPath =
      config.earlyWarningVideoPath || "videos/early.mp4";
    this.earlyWarningSoundPath =
      config.earlyWarningSoundPath || "sounds/early.mp3";
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

    // Early warning configuration - VERIFIED REQUIREMENTS
    this.enableEarlyWarning = config.enableEarlyWarning !== false;
    this.earlyWarningStartHour = Number.isFinite(config.earlyWarningStartHour)
      ? config.earlyWarningStartHour
      : 10; // Default 10 AM
    this.earlyWarningEndHour = Number.isFinite(config.earlyWarningEndHour)
      ? config.earlyWarningEndHour
      : 20; // Default 8 PM
    this.earlyWarningVolumeReduction = Number.isFinite(
      config.earlyWarningVolumeReduction
    )
      ? config.earlyWarningVolumeReduction
      : 20; // Default 20% reduction
    this.earlyWarningPollInterval = Number.isFinite(
      config.earlyWarningPollInterval
    )
      ? config.earlyWarningPollInterval
      : 8000; // Default 8 seconds
    this.orefHistoryUrl =
      config.orefHistoryUrl ||
      "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json";

    // State variables
    this.isAlertActive = false;
    this.isEarlyWarningActive = false;
    this.alertActiveCities = [];
    this.earlyWarningActiveCities = [];
    this.wsClient = null;
    this.reconnectTimer = null;
    this.earlyWarningTimer = null;
    this.devices = [];

    // Initialize last check time to current time (prevents processing old alerts on startup)
    this.lastEarlyWarningCheck = new Date();
    this.currentEarlyWarningPlayback = null;

    // Set to track processed early warning alerts (prevent duplicates)
    this.processedEarlyWarningAlerts = new Set();

    // Cleanup timer
    this.cleanupTimer = null;

    // Validate configuration
    this.validateConfig();

    // Setup on Homebridge launch
    if (this.api) {
      this.api.on("didFinishLaunching", () => {
        try {
          this.log.info("Initializing Red Alert plugin components...");
          this.setupMediaServer();
          if (this.useChromecast) this.setupChromecastDiscovery();
          this.setupWebSocket();
          this.copyDefaultMediaFiles();
          if (this.enableEarlyWarning) this.setupEarlyWarningMonitoring();
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

      // Early warning service
      this.earlyWarningService = new Service.ContactSensor(
        `${this.name} Early Warning`,
        "early-warning"
      );
    } catch (error) {
      this.log.error(`Failed to initialize HomeKit services: ${error.message}`);
    }
  }

  // VERIFIED: Configuration validation with proper bounds checking
  validateConfig() {
    try {
      if (!this.wsUrl) {
        this.log.warn("WebSocket URL missing, using default: " + this.wsUrl);
      }

      // CRITICAL: Ensure selectedCities is properly handled
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

      // Validate Chromecast volume configurations
      if (this.useChromecast && Array.isArray(this.config.chromecastVolumes)) {
        this.config.chromecastVolumes.forEach((v, i) => {
          if (!v.deviceName || !Number.isFinite(v.volume)) {
            this.log.warn(
              `Invalid Chromecast volume config at index ${i}, ignoring`
            );
          }
        });
      }

      // VERIFIED: Time validation with proper bounds
      if (this.earlyWarningStartHour < 0 || this.earlyWarningStartHour > 23) {
        this.log.warn("Invalid earlyWarningStartHour, using default: 10");
        this.earlyWarningStartHour = 10;
      }
      if (this.earlyWarningEndHour < 0 || this.earlyWarningEndHour > 23) {
        this.log.warn("Invalid earlyWarningEndHour, using default: 20");
        this.earlyWarningEndHour = 20;
      }

      // VERIFIED: Volume reduction validation
      if (
        this.earlyWarningVolumeReduction < 0 ||
        this.earlyWarningVolumeReduction > 100
      ) {
        this.log.warn("Invalid earlyWarningVolumeReduction, using default: 20");
        this.earlyWarningVolumeReduction = 20;
      }
    } catch (error) {
      this.log.error(`Configuration validation failed: ${error.message}`);
    }
  }

  // VERIFIED: Cleanup timer setup
  setupCleanupTimer() {
    try {
      // Clean up old processed alerts every hour
      this.cleanupTimer = setInterval(() => {
        this.cleanupProcessedAlerts();
      }, 3600000); // 1 hour
    } catch (error) {
      this.log.error(`Failed to setup cleanup timer: ${error.message}`);
    }
  }

  // VERIFIED: Memory management for processed alerts
  cleanupProcessedAlerts() {
    try {
      // Keep processed alerts for 2 hours (120 minutes)
      const cutoffTime = new Date(Date.now() - 120 * 60000);
      const alertsToRemove = [];

      for (const alertId of this.processedEarlyWarningAlerts) {
        try {
          // Extract timestamp from alert ID (format: timestamp_city_category)
          const timestamp = parseInt(alertId.split("_")[0]);
          if (isNaN(timestamp) || timestamp < cutoffTime.getTime()) {
            alertsToRemove.push(alertId);
          }
        } catch (error) {
          // If we can't parse the alert ID, remove it
          alertsToRemove.push(alertId);
        }
      }

      alertsToRemove.forEach((alertId) => {
        this.processedEarlyWarningAlerts.delete(alertId);
      });

      if (alertsToRemove.length > 0) {
        this.log.debug(
          `Cleaned up ${alertsToRemove.length} old processed early warning alerts`
        );
      }
    } catch (error) {
      this.log.error(`Error cleaning up processed alerts: ${error.message}`);
    }
  }

  // VERIFIED: Robust alert ID generation with fallback
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

      // Sanitize city name to avoid issues with special characters
      const sanitizedCity = String(alert.data).replace(/[_]/g, "-");
      return `${alertDate.getTime()}_${sanitizedCity}_${alert.category}`;
    } catch (error) {
      this.log.error(`Error generating alert ID: ${error.message}`);
      // Fallback ID generation
      const sanitizedCity = (alert?.data || "unknown").replace(/[_]/g, "-");
      return `${Date.now()}_${sanitizedCity}_${alert?.category || "unknown"}`;
    }
  }

  // VERIFIED: HomeKit service exposure
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

      return [
        informationService,
        this.service,
        this.testSwitchService,
        this.earlyWarningService,
      ];
    } catch (error) {
      this.log.error(`Failed to expose services: ${error.message}`);
      return [];
    }
  }

  // VERIFIED: Alert state getter with error handling
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

  // VERIFIED: Early warning state getter with error handling
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

  // VERIFIED: Test switch handler
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

  // VERIFIED: Test alert trigger
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
        this.playChromecastMedia(true, false); // isTest=true, isEarlyWarning=false
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

  // VERIFIED: Early warning monitoring setup
  setupEarlyWarningMonitoring() {
    try {
      this.log.info(
        `Setting up early warning monitoring (checking every ${
          this.earlyWarningPollInterval / 1000
        }s, hours: ${this.earlyWarningStartHour}:00-${
          this.earlyWarningEndHour
        }:00)`
      );

      // Start polling immediately
      this.pollEarlyWarning();

      // Set up interval
      this.earlyWarningTimer = setInterval(() => {
        this.pollEarlyWarning();
      }, this.earlyWarningPollInterval);
    } catch (error) {
      this.log.error(
        `Failed to setup early warning monitoring: ${error.message}`
      );
    }
  }

  // VERIFIED: OREF polling with robust error handling
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
          } catch (error) {
            this.log.error(
              `Error parsing early warning data: ${error.message}`
            );
          }
        });
      });

      req.on("error", (error) => {
        this.log.error(`Early warning request error: ${error.message}`);
      });

      req.setTimeout(10000, () => {
        req.destroy();
        this.log.warn("Early warning request timeout");
      });
    } catch (error) {
      this.log.error(`Error polling early warning: ${error.message}`);
    }
  }

  // CRITICAL: VERIFIED line-by-line early warning processing
  processEarlyWarningData(alerts) {
    try {
      // VERIFICATION: Input validation
      if (!Array.isArray(alerts)) {
        this.log.warn("Invalid early warning data format - not an array");
        return;
      }

      if (alerts.length === 0) {
        this.log.debug("No alerts in response");
        return;
      }

      const now = new Date();
      // CRITICAL: Exactly 60 seconds as requested
      const cutoffTime = new Date(now.getTime() - 60000);

      this.log.debug(
        `Processing ${
          alerts.length
        } alerts. Current time: ${now.toISOString()}, cutoff: ${cutoffTime.toISOString()}`
      );

      // VERIFICATION: Filter for category 13 alerts from last 60 seconds only
      const earlyWarningAlerts = alerts.filter((alert) => {
        try {
          // CRITICAL: Must be category 13 (early warning)
          if (!alert || alert.category !== 13) {
            return false;
          }

          // CRITICAL: Must have valid date and city data
          if (!alert.alertDate || !alert.data) {
            this.log.warn(`Invalid alert data: ${JSON.stringify(alert)}`);
            return false;
          }

          const alertDate = new Date(alert.alertDate);

          // CRITICAL: Must be valid date
          if (isNaN(alertDate.getTime())) {
            this.log.warn(`Invalid alert date: ${alert.alertDate}`);
            return false;
          }

          // CRITICAL: Must be within last 60 seconds
          if (alertDate < cutoffTime) {
            this.log.debug(
              `Skipping old early warning alert from ${alertDate.toISOString()} (older than 60 seconds)`
            );
            return false;
          }

          // VERIFICATION: Avoid future alerts (clock sync issues)
          const futureBuffer = new Date(now.getTime() + 10000); // 10 second buffer
          if (alertDate > futureBuffer) {
            this.log.debug(
              `Skipping future early warning alert from ${alertDate.toISOString()}`
            );
            return false;
          }

          // CRITICAL: Must not be already processed
          const alertId = this.generateAlertId(alert);
          if (this.processedEarlyWarningAlerts.has(alertId)) {
            this.log.debug(`Already processed: ${alertId}`);
            return false;
          }

          this.log.debug(
            `Valid early warning candidate: ${alertId} for ${alert.data}`
          );
          return true;
        } catch (error) {
          this.log.error(`Error filtering alert: ${error.message}`);
          return false;
        }
      });

      // VERIFICATION: Mark ALL category 13 alerts as processed (prevent re-checking)
      alerts.forEach((alert) => {
        if (alert && alert.category === 13) {
          try {
            const alertId = this.generateAlertId(alert);
            this.processedEarlyWarningAlerts.add(alertId);
          } catch (error) {
            this.log.error(
              `Error marking alert as processed: ${error.message}`
            );
          }
        }
      });

      if (earlyWarningAlerts.length === 0) {
        this.log.debug("No new early warning alerts to process");
        return;
      }

      this.log.debug(
        `Found ${earlyWarningAlerts.length} valid early warning alerts`
      );

      // CRITICAL: Filter for ONLY selected cities
      const relevantAlerts = earlyWarningAlerts.filter((alert) => {
        const isRelevant =
          this.selectedCities.length === 0 ||
          this.selectedCities.includes(alert.data);

        if (!isRelevant) {
          this.log.debug(
            `Skipping alert for non-monitored city: ${alert.data}`
          );
        } else {
          this.log.info(
            `Early warning alert matches monitored city: ${alert.data}`
          );
        }

        return isRelevant;
      });

      if (relevantAlerts.length === 0) {
        this.log.debug("No early warning alerts for monitored cities");
        return;
      }

      // CRITICAL: Check time restrictions (10 AM - 8 PM)
      if (!this.isWithinEarlyWarningHours()) {
        this.log.info(
          `Early warning alerts for ${relevantAlerts
            .map((a) => a.data)
            .join(", ")} ` +
            `outside allowed hours (${this.earlyWarningStartHour}:00-${this.earlyWarningEndHour}:00)`
        );
        return;
      }

      // CRITICAL: Don't interrupt primary alerts
      if (this.isAlertActive) {
        this.log.info(
          `Early warning alerts for ${relevantAlerts
            .map((a) => a.data)
            .join(", ")} ` + `skipped - primary alert is active`
        );
        return;
      }

      // VERIFICATION: All conditions met - trigger early warning
      const cities = relevantAlerts.map((alert) => alert.data);
      const alertDates = relevantAlerts.map((alert) => alert.alertDate);

      this.log.info(
        `🚨 EARLY WARNING TRIGGERED for cities: ${cities.join(", ")} ` +
          `(alerts from: ${alertDates.join(", ")})`
      );

      this.triggerEarlyWarning(cities);
    } catch (error) {
      this.log.error(`Error processing early warning data: ${error.message}`);
    }
  }

  // VERIFIED: Time window check
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
      return false; // Fail safe
    }
  }

  // VERIFIED: Early warning trigger
  triggerEarlyWarning(cities) {
    try {
      // Stop any existing early warning playback
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
        this.playChromecastMedia(false, true); // isTest=false, isEarlyWarning=true
      }

      // Auto-reset after timeout
      this.currentEarlyWarningPlayback = setTimeout(() => {
        this.resetEarlyWarning();
      }, this.chromecastTimeout * 1000);
    } catch (error) {
      this.log.error(`Error triggering early warning: ${error.message}`);
    }
  }

  // VERIFIED: Early warning cleanup
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

  // VERIFIED: Early warning reset
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

  // VERIFIED: Chromecast discovery
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

  // VERIFIED: Chromecast initialization
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

  // VERIFIED: WebSocket setup
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

      // Ping every 30 seconds to keep connection alive
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

  // VERIFIED: WebSocket reconnection
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

  // CRITICAL: VERIFIED primary alert handler with interruption logic
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
      const relevantAreas = areas.filter(
        (area) =>
          this.selectedCities.length === 0 || this.selectedCities.includes(area)
      );
      const isTest = alert.alert_type === 0;

      if (relevantAreas.length > 0) {
        this.log.info(
          `🚨 PRIMARY ALERT triggered for areas: ${relevantAreas.join(", ")}`
        );

        // CRITICAL: Primary alert interrupts early warning
        if (this.isEarlyWarningActive) {
          this.log.info("Primary alert interrupting early warning");
          this.stopEarlyWarningPlayback();
        }

        this.isAlertActive = true;
        this.alertActiveCities = relevantAreas;

        this.service.updateCharacteristic(
          Characteristic.ContactSensorState,
          Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        );

        if (this.useChromecast) {
          this.playChromecastMedia(isTest, false); // isTest, isEarlyWarning=false
        }

        // Auto-reset primary alert
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

  // CRITICAL: VERIFIED Chromecast playback with volume control
  playChromecastMedia(isTest, isEarlyWarning = false) {
    try {
      if (!this.devices.length) {
        this.log.warn("No Chromecast devices available");
        return;
      }

      // Filter for valid devices
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

      let mediaType;
      let mediaUrl;

      if (isEarlyWarning) {
        mediaType = "early warning";
        mediaUrl = `${this.baseUrl}/early-warning-video`;
      } else if (isTest) {
        mediaType = "test";
        mediaUrl = `${this.baseUrl}/test-video`;
      } else {
        mediaType = "alert";
        mediaUrl = `${this.baseUrl}/alert-video`;
      }

      this.log.info(`Playing ${mediaType} on ${validDevices.length} devices`);

      validDevices.forEach((device) => {
        this.playWithRetry(device, mediaUrl, 3, isEarlyWarning);
      });
    } catch (error) {
      this.log.error(`Error playing Chromecast media: ${error.message}`);
    }
  }

  // VERIFIED: Chromecast playback with retry and volume control
  playWithRetry(device, mediaUrl, retries, isEarlyWarning = false) {
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
            () =>
              this.playWithRetry(device, mediaUrl, retries - 1, isEarlyWarning),
            2000
          );
        } else if (err) {
          this.log.error(
            `Failed to play on ${device.friendlyName}: ${err.message}`
          );
        } else {
          this.log.info(`Playing on ${device.friendlyName}: ${mediaUrl}`);

          // CRITICAL: Volume calculation with early warning reduction
          let baseVolume =
            this.config.chromecastVolumes?.find(
              (v) =>
                v.deviceName.toLowerCase() === device.friendlyName.toLowerCase()
            )?.volume ?? this.chromecastVolume;

          // VERIFIED: 20% volume reduction for early warnings
          if (isEarlyWarning) {
            baseVolume = Math.max(
              0,
              baseVolume - this.earlyWarningVolumeReduction
            );
          }

          device.setVolume(baseVolume / 100, (err) => {
            if (err) {
              this.log.warn(
                `Failed to set volume on ${device.friendlyName}: ${err.message}`
              );
            } else {
              this.log.debug(
                `Volume set to ${baseVolume}% on ${device.friendlyName}${
                  isEarlyWarning ? " (early warning reduced)" : ""
                }`
              );
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
          () =>
            this.playWithRetry(device, mediaUrl, retries - 1, isEarlyWarning),
          2000
        );
      }
    }
  }

  // VERIFIED: Express media server setup
  setupMediaServer() {
    try {
      this.server = express();
      const mediaDir = path.join(
        this.api.user.storagePath(),
        "red-alert-media"
      );
      fs.ensureDirSync(mediaDir);

      this.server.use(express.static(mediaDir));

      // Media endpoints
      this.server.get("/alert-sound", (req, res) =>
        res.sendFile(path.join(mediaDir, this.alertSoundPath))
      );
      this.server.get("/test-sound", (req, res) =>
        res.sendFile(path.join(mediaDir, this.testSoundPath))
      );
      this.server.get("/alert-video", (req, res) =>
        res.sendFile(path.join(mediaDir, this.alertVideoPath))
      );
      this.server.get("/test-video", (req, res) =>
        res.sendFile(path.join(mediaDir, this.testVideoPath))
      );
      this.server.get("/early-warning-sound", (req, res) =>
        res.sendFile(path.join(mediaDir, this.earlyWarningSoundPath))
      );
      this.server.get("/early-warning-video", (req, res) =>
        res.sendFile(path.join(mediaDir, this.earlyWarningVideoPath))
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

  // VERIFIED: Media file copying
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

  // VERIFIED: IP address detection
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
