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

    // Early warning configuration
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

    // Early warning alert age limit (don't process alerts older than this many minutes)
    this.earlyWarningMaxAge = Number.isFinite(config.earlyWarningMaxAge)
      ? config.earlyWarningMaxAge
      : 30; // 30 minutes default

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
    this.currentEarlyWarningPlayback = null; // Track current early warning playback

    // Set to track processed early warning alerts (prevent duplicates)
    this.processedEarlyWarningAlerts = new Set();

    // Cleanup old processed alerts periodically (every hour)
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

  // Validate configuration
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
      }
      if (this.useChromecast && Array.isArray(this.config.chromecastVolumes)) {
        this.config.chromecastVolumes.forEach((v, i) => {
          if (!v.deviceName || !Number.isFinite(v.volume)) {
            this.log.warn(
              `Invalid Chromecast volume config at index ${i}, ignoring`
            );
          }
        });
      }
      if (this.earlyWarningStartHour < 0 || this.earlyWarningStartHour > 23) {
        this.log.warn("Invalid earlyWarningStartHour, using default: 10");
        this.earlyWarningStartHour = 10;
      }
      if (this.earlyWarningEndHour < 0 || this.earlyWarningEndHour > 23) {
        this.log.warn("Invalid earlyWarningEndHour, using default: 20");
        this.earlyWarningEndHour = 20;
      }
      if (this.earlyWarningMaxAge < 1) {
        this.log.warn("Invalid earlyWarningMaxAge, using default: 30 minutes");
        this.earlyWarningMaxAge = 30;
      }
    } catch (error) {
      this.log.error(`Configuration validation failed: ${error.message}`);
    }
  }

  // Setup cleanup timer for processed alerts
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

  // Clean up old processed alert IDs
  cleanupProcessedAlerts() {
    try {
      const cutoffTime = new Date(
        Date.now() - this.earlyWarningMaxAge * 60000 * 2
      ); // Keep twice the max age
      const alertsToRemove = [];

      for (const alertId of this.processedEarlyWarningAlerts) {
        try {
          // Extract timestamp from alert ID (format: timestamp_city_category)
          const timestamp = parseInt(alertId.split("_")[0]);
          if (timestamp < cutoffTime.getTime()) {
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

  // Generate unique alert ID
  generateAlertId(alert) {
    try {
      const alertDate = new Date(alert.alertDate);
      return `${alertDate.getTime()}_${alert.data}_${alert.category}`;
    } catch (error) {
      this.log.error(`Error generating alert ID: ${error.message}`);
      return `${Date.now()}_${alert.data || "unknown"}_${
        alert.category || "unknown"
      }`;
    }
  }

  // Expose HomeKit services
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

  // Get current alert state for HomeKit
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

  // Get current early warning state for HomeKit
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

  // Handle test switch toggle from HomeKit
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

  // Trigger a test alert
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

  // Setup early warning monitoring
  setupEarlyWarningMonitoring() {
    try {
      this.log.info(
        `Setting up early warning monitoring (checking every ${
          this.earlyWarningPollInterval / 1000
        }s, max age: ${this.earlyWarningMaxAge}min)`
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

  // Poll OREF for early warning alerts
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
            this.processEarlyWarningData(JSON.parse(data));
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

  // Process early warning data from OREF
  processEarlyWarningData(alerts) {
    try {
      if (!Array.isArray(alerts)) {
        this.log.warn("Invalid early warning data format");
        return;
      }

      const now = new Date();
      const cutoffTime = new Date(
        now.getTime() - this.earlyWarningMaxAge * 60000
      );

      this.log.debug(
        `Processing early warning data. Current time: ${now.toISOString()}, cutoff time: ${cutoffTime.toISOString()}`
      );

      // Filter for category 13 alerts
      const earlyWarningAlerts = alerts.filter((alert) => {
        if (alert.category !== 13) return false;

        try {
          const alertDate = new Date(alert.alertDate);

          // Skip alerts that are too old
          if (alertDate < cutoffTime) {
            this.log.debug(
              `Skipping old early warning alert from ${alertDate.toISOString()} (older than ${
                this.earlyWarningMaxAge
              } minutes)`
            );
            return false;
          }

          // Skip alerts that are newer than our last check plus a small buffer (avoid future alerts)
          const futureBuffer = new Date(
            this.lastEarlyWarningCheck.getTime() + 60000
          ); // 1 minute buffer
          if (alertDate > futureBuffer) {
            this.log.debug(
              `Skipping future early warning alert from ${alertDate.toISOString()} (too far in future)`
            );
            return false;
          }

          // Skip alerts we've already processed
          const alertId = this.generateAlertId(alert);
          if (this.processedEarlyWarningAlerts.has(alertId)) {
            this.log.debug(
              `Skipping already processed early warning alert: ${alertId}`
            );
            return false;
          }

          return true;
        } catch (error) {
          this.log.error(
            `Error parsing alert date for alert: ${JSON.stringify(
              alert
            )}, error: ${error.message}`
          );
          return false;
        }
      });

      if (earlyWarningAlerts.length === 0) {
        this.log.debug("No new early warning alerts to process");
        return;
      }

      this.log.debug(
        `Found ${earlyWarningAlerts.length} new early warning alerts`
      );

      // Filter for relevant cities
      const relevantAlerts = earlyWarningAlerts.filter(
        (alert) =>
          this.selectedCities.length === 0 ||
          this.selectedCities.includes(alert.data)
      );

      if (relevantAlerts.length === 0) {
        this.log.debug("No early warning alerts for monitored cities");
        // Still mark these as processed to avoid checking them again
        earlyWarningAlerts.forEach((alert) => {
          const alertId = this.generateAlertId(alert);
          this.processedEarlyWarningAlerts.add(alertId);
        });
        return;
      }

      // Check if we're within allowed hours
      if (!this.isWithinEarlyWarningHours()) {
        this.log.info(
          `Early warning alerts received for ${relevantAlerts
            .map((a) => a.data)
            .join(", ")} but outside allowed hours (${
            this.earlyWarningStartHour
          }:00-${this.earlyWarningEndHour}:00)`
        );
        // Mark as processed even if not played due to time restrictions
        relevantAlerts.forEach((alert) => {
          const alertId = this.generateAlertId(alert);
          this.processedEarlyWarningAlerts.add(alertId);
        });
        return;
      }

      // Don't interrupt primary alerts
      if (this.isAlertActive) {
        this.log.info(
          `Early warning alerts received but primary alert is active, skipping`
        );
        // Mark as processed even if not played due to primary alert
        relevantAlerts.forEach((alert) => {
          const alertId = this.generateAlertId(alert);
          this.processedEarlyWarningAlerts.add(alertId);
        });
        return;
      }

      const cities = relevantAlerts.map((alert) => alert.data);
      const alertDates = relevantAlerts.map((alert) => alert.alertDate);

      this.log.info(
        `Early warning triggered for areas: ${cities.join(
          ", "
        )} (alerts from: ${alertDates.join(", ")})`
      );

      // Mark alerts as processed
      relevantAlerts.forEach((alert) => {
        const alertId = this.generateAlertId(alert);
        this.processedEarlyWarningAlerts.add(alertId);
        this.log.debug(`Marked early warning alert as processed: ${alertId}`);
      });

      this.triggerEarlyWarning(cities);

      // Update last check time to current time
      this.lastEarlyWarningCheck = now;
    } catch (error) {
      this.log.error(`Error processing early warning data: ${error.message}`);
    }
  }

  // Check if current time is within early warning hours
  isWithinEarlyWarningHours() {
    const now = new Date();
    const currentHour = now.getHours();
    const isWithinHours =
      currentHour >= this.earlyWarningStartHour &&
      currentHour < this.earlyWarningEndHour;

    this.log.debug(
      `Current hour: ${currentHour}, allowed hours: ${this.earlyWarningStartHour}-${this.earlyWarningEndHour}, within hours: ${isWithinHours}`
    );

    return isWithinHours;
  }

  // Trigger early warning alert
  triggerEarlyWarning(cities) {
    try {
      // Stop any existing early warning playback
      if (this.currentEarlyWarningPlayback) {
        this.stopEarlyWarningPlayback();
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

  // Stop early warning playback
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

  // Reset early warning state
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

  // Setup continuous Chromecast device discovery
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

  // Initialize Chromecast client
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
              `Chromecast '${device.friendlyName}' lacks playback functions`
            );
            return;
          }
          this.log.info(
            `Chromecast discovered: ${device.friendlyName} at ${device.host}`
          );
          if (!this.devices.some((d) => d.host === device.host)) {
            this.devices.push(device);
          }
          if (
            this.config.chromecastVolumes &&
            !this.devices.some((d) =>
              this.config.chromecastVolumes.some(
                (v) => v.deviceName === d.friendlyName
              )
            )
          ) {
            this.log.warn("Some configured Chromecast devices not discovered");
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

  // Setup WebSocket connection
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
        if (this.wsClient.readyState === WebSocket.OPEN) {
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

  // Schedule WebSocket reconnection
  scheduleReconnect() {
    try {
      if (!this.reconnectTimer) {
        this.log.info(
          `Scheduling WebSocket reconnect in ${
            this.reconnectInterval / 1000
          } seconds`
        );
        this.reconnectTimer = setTimeout(() => {
          this.setupWebSocket();
        }, this.reconnectInterval);
      }
    } catch (error) {
      this.log.error(`Error scheduling reconnect: ${error.message}`);
    }
  }

  // Handle WebSocket alert messages
  handleAlertMessage(message) {
    try {
      const alert = JSON.parse(message);
      if (!alert || !alert.areas || typeof alert.areas !== "string") {
        this.log.warn("Invalid alert message format");
        return;
      }

      const areas = alert.areas.split(",").map((s) => s.trim());
      const relevantAreas = areas.filter(
        (area) =>
          this.selectedCities.length === 0 || this.selectedCities.includes(area)
      );
      const isTest = alert.alert_type === 0;

      if (relevantAreas.length > 0) {
        this.log.info(`Alert triggered for areas: ${relevantAreas.join(", ")}`);

        // Primary alert interrupts early warning
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

        setTimeout(() => {
          if (this.isAlertActive) {
            this.log.info("Auto-resetting alert state");
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

  // Play media on Chromecast devices
  playChromecastMedia(isTest, isEarlyWarning = false) {
    try {
      if (!this.devices.length) {
        this.log.warn("No Chromecast devices available");
        return;
      }

      // Filter devices to ensure they are valid
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

  // Play media with retry logic
  playWithRetry(device, mediaUrl, retries, isEarlyWarning = false) {
    try {
      // Log device state for debugging (optional, remove if too verbose)
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

          // Calculate volume based on alert type
          let baseVolume =
            this.config.chromecastVolumes?.find(
              (v) =>
                v.deviceName.toLowerCase() === device.friendlyName.toLowerCase()
            )?.volume ?? this.chromecastVolume;

          // Reduce volume for early warning
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
        this.log.warn(
          `Retrying playback on ${device.friendlyName} (${retries} left)`
        );
        setTimeout(
          () =>
            this.playWithRetry(device, mediaUrl, retries - 1, isEarlyWarning),
          2000
        );
      } else {
        this.log.error(
          `Giving up on ${device.friendlyName} after all retries exhausted`
        );
      }
    }
  }

  // Setup Express media server
  setupMediaServer() {
    try {
      this.server = express();
      const mediaDir = path.join(
        this.api.user.storagePath(),
        "red-alert-media"
      );
      fs.ensureDirSync(mediaDir);

      this.server.use(express.static(mediaDir));
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

  // Copy default media files
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

  // Get local IP address
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
      this.log.warn("No valid network interface, using localhost");
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
