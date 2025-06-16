/**
 * Homebridge Red Alert Plugin
 * Monitors Israeli Home Front Command alerts and provides HomeKit/Chromecast notifications for:
 * - Primary (real-time, via WebSocket)
 * - Early Warning (polling, category 13, specific title)
 * - Flash/Shelter (polling, category 14, specific titles)
 * - Exit Notification (polling, category 13, specific title)
 *
 * Features:
 * - Per-alert-type enable/time/volume controls
 * - Per-device, per-alert-type volume
 * - City filtering (by Hebrew name or "ברחבי הארץ")
 * - Deduplication for all alert messages (no double notifications)
 * - Configurable media files for all alert types
 * - Chromecast playback ends ONLY when the video/audio ends (using device 'finished' event)
 * - Robust, production-ready error handling and logging
 *
 * Author: YourName
 * License: MIT
 */

const WebSocket = require("ws");
const fs = require("fs-extra");
const path = require("path");
const express = require("express");
const ChromecastAPI = require("chromecast-api");
const https = require("https");
const os = require("os");

let Service, Characteristic;

// Alert types and their canonical titles (in Hebrew)
const ALERT_TYPES = {
  PRIMARY: "primary",
  TEST: "test",
  EARLY_WARNING: "early-warning",
  FLASH_SHELTER: "flash-shelter",
  EXIT_NOTIFICATION: "exit-notification",
};
const ALERT_TITLES = {
  EARLY_WARNING: "בדקות הקרובות צפויות להתקבל התרעות באזורך",
  FLASH_SHELTER: "שהייה בסמיכות למרחב מוגן",
  EXIT_NOTIFICATION: "ניתן לצאת מהמרחב המוגן",
};
const DEFAULT_ALERTS_CONFIG = {
  [ALERT_TYPES.EARLY_WARNING]: {
    enabled: true,
    startHour: 8,
    endHour: 20,
    volume: 60,
  },
  [ALERT_TYPES.FLASH_SHELTER]: {
    enabled: true,
    startHour: 0,
    endHour: 23,
    volume: 50,
  },
  [ALERT_TYPES.EXIT_NOTIFICATION]: {
    enabled: true,
    startHour: 0,
    endHour: 23,
    volume: 45,
  },
};
const DEFAULT_MEDIA_PATHS = {
  alertVideoPath: "videos/alert.mp4",
  earlyWarningVideoPath: "videos/early.mp4",
  flashAlertShelterVideoPath: "videos/flash-shelter.mp4",
  exitNotificationVideoPath: "videos/exit.mp4",
  testVideoPath: "videos/test.mp4",
};

class RedAlertPlugin {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};

    // --- Media file paths
    for (const key in DEFAULT_MEDIA_PATHS) {
      this[key] = config[key] || DEFAULT_MEDIA_PATHS[key];
    }

    // --- General settings
    this.name = config.name || "Red Alert";
    this.selectedCities = Array.isArray(config.cities) ? config.cities : [];
    this.useChromecast = config.useChromecast !== false;
    this.chromecastVolume = Number.isFinite(config.chromecastVolume)
      ? config.chromecastVolume
      : 50;
    this.chromecastTimeout = Number.isFinite(config.chromecastTimeout)
      ? config.chromecastTimeout
      : 30;
    this.serverPort = Number.isFinite(config.serverPort)
      ? config.serverPort
      : 8095;
    this.wsUrl = config.wsUrl || "ws://ws.cumta.morhaviv.com:25565/ws";
    this.reconnectInterval = Number.isFinite(config.reconnectInterval)
      ? config.reconnectInterval
      : 5000;
    this.baseUrl =
      config.baseUrl || `http://${this.getIpAddress()}:${this.serverPort}`;
    this.orefHistoryUrl =
      config.orefHistoryUrl ||
      "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json";
    this.earlyWarningPollInterval = Number.isFinite(
      config.earlyWarningPollInterval
    )
      ? config.earlyWarningPollInterval
      : 8000;

    // --- Per-alert-type config (enable, time, volume)
    this.alertsConfig = this.parseAlertsConfig(config);

    // --- Per-device, per-alert volume
    this.chromecastVolumes = Array.isArray(config.chromecastVolumes)
      ? config.chromecastVolumes
      : [];
    this.deviceOverrides = this.parseDeviceOverrides(this.chromecastVolumes);

    // --- State for deduplication and HomeKit
    this.isAlertActive = false;
    this.isEarlyWarningActive = false;
    this.isFlashAlertActive = false;
    this.isExitNotificationActive = false;
    this.alertActiveCities = [];
    this.earlyWarningActiveCities = [];
    this.flashAlertActiveCities = [];
    this.exitNotificationActiveCities = [];
    this.wsClient = null;
    this.reconnectTimer = null;
    this.earlyWarningTimer = null;
    this.devices = [];

    // Deduplication sets: store unique alert IDs for each type (timestamp+city+title)
    this.processedEarlyWarningAlerts = new Set();
    this.processedFlashAlerts = new Set();
    this.processedExitNotifications = new Set();

    // Track which devices are currently playing for each alert type
    this.chromecastPlayingStatus = {
      [ALERT_TYPES.EARLY_WARNING]: new Set(),
      [ALERT_TYPES.FLASH_SHELTER]: new Set(),
      [ALERT_TYPES.EXIT_NOTIFICATION]: new Set(),
    };

    // --- HomeKit services
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
    this.exitNotificationService = new Service.ContactSensor(
      `${this.name} Exit Notification`,
      "exit-notification"
    );

    // --- Startup logic
    if (this.api) {
      this.api.on("didFinishLaunching", () => {
        this.log.info("Initializing Red Alert plugin...");
        this.setupMediaServer();
        this.copyDefaultMediaFiles();
        if (this.useChromecast) this.setupChromecastDiscovery();
        this.setupWebSocket();
        this.setupEarlyWarningMonitoring();
        this.setupCleanupTimer();
      });
    }
  }

  /**
   * Merge user config for alerts with plugin defaults.
   */
  parseAlertsConfig(config) {
    const alerts = config.alerts || {};
    const result = {};
    for (const type of [
      ALERT_TYPES.EARLY_WARNING,
      ALERT_TYPES.FLASH_SHELTER,
      ALERT_TYPES.EXIT_NOTIFICATION,
    ]) {
      result[type] = Object.assign(
        {},
        DEFAULT_ALERTS_CONFIG[type],
        alerts[type]
      );
    }
    return result;
  }

  /**
   * Parse per-device, per-alert volume overrides from user config.
   */
  parseDeviceOverrides(chromecastVolumes) {
    const result = {};
    (chromecastVolumes || []).forEach((dev) => {
      if (!dev.deviceName) return;
      const devKey = dev.deviceName.toLowerCase();
      result[devKey] = {
        volume: dev.volume,
        alerts: {},
      };
      if (typeof dev.alerts === "object" && dev.alerts !== null) {
        for (const type of [
          ALERT_TYPES.EARLY_WARNING,
          ALERT_TYPES.FLASH_SHELTER,
          ALERT_TYPES.EXIT_NOTIFICATION,
        ]) {
          if (dev.alerts[type] && typeof dev.alerts[type].volume === "number") {
            result[devKey].alerts[type] = { volume: dev.alerts[type].volume };
          }
        }
      }
    });
    return result;
  }

  /**
   * Homebridge services: ContactSensors for each alert type + test Switch.
   */
  getServices() {
    const informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, "Homebridge")
      .setCharacteristic(Characteristic.Model, "Red Alert")
      .setCharacteristic(Characteristic.SerialNumber, "2.0.0");

    this.service
      .getCharacteristic(Characteristic.ContactSensorState)
      .on("get", this.getAlertState.bind(this));
    this.earlyWarningService
      .getCharacteristic(Characteristic.ContactSensorState)
      .on("get", this.getEarlyWarningState.bind(this));
    this.flashAlertService
      .getCharacteristic(Characteristic.ContactSensorState)
      .on("get", this.getFlashAlertState.bind(this));
    this.exitNotificationService
      .getCharacteristic(Characteristic.ContactSensorState)
      .on("get", this.getExitNotificationState.bind(this));

    return [
      informationService,
      this.service,
      this.testSwitchService,
      this.earlyWarningService,
      this.flashAlertService,
      this.exitNotificationService,
    ];
  }
  getAlertState(callback) {
    callback(
      null,
      this.isAlertActive
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED
    );
  }
  getEarlyWarningState(callback) {
    callback(
      null,
      this.isEarlyWarningActive
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED
    );
  }
  getFlashAlertState(callback) {
    callback(
      null,
      this.isFlashAlertActive
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED
    );
  }
  getExitNotificationState(callback) {
    callback(
      null,
      this.isExitNotificationActive
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED
    );
  }
  handleTestSwitch(on, callback) {
    if (on) {
      this.log.info("Running alert test");
      this.triggerTest();
      setTimeout(() => {
        this.testSwitchService.updateCharacteristic(Characteristic.On, false);
      }, 2000);
    }
    callback(null);
  }
  triggerTest() {
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
      this.playChromecastMedia(ALERT_TYPES.TEST);
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
  }

  /**
   * Deduplication cleanup - remove old processed alert IDs hourly.
   */
  setupCleanupTimer() {
    setInterval(() => {
      const cutoff = Date.now() - 2 * 60 * 60 * 1000;
      for (const [set, name] of [
        [this.processedEarlyWarningAlerts, "early warning"],
        [this.processedFlashAlerts, "flash alert"],
        [this.processedExitNotifications, "exit notification"],
      ]) {
        let removed = 0;
        for (const id of set) {
          const ts = parseInt(id.split("_")[0]);
          if (isNaN(ts) || ts < cutoff) {
            set.delete(id);
            removed++;
          }
        }
        if (removed)
          this.log.debug(`Cleaned up ${removed} processed ${name} entries`);
      }
    }, 3600000);
  }

  /**
   * Poll OREF API for early warning / flash / exit notification every N seconds.
   */
  setupEarlyWarningMonitoring() {
    this.pollEarlyWarning();
    this.earlyWarningTimer = setInterval(
      () => this.pollEarlyWarning(),
      this.earlyWarningPollInterval
    );
  }
  pollEarlyWarning() {
    const options = {
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": "Mozilla/5.0",
      },
    };
    const req = https.get(this.orefHistoryUrl, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          this.log.warn(`OREF API returned status: ${res.statusCode}`);
          return;
        }
        try {
          const parsedData = JSON.parse(data);
          this.processEarlyWarningData(parsedData);
          this.processFlashAlertData(parsedData);
          this.processExitNotificationData(parsedData);
        } catch (err) {
          this.log.error(`Error parsing alert data: ${err.message}`);
        }
      });
    });
    req.on("error", (error) =>
      this.log.error(`Alert polling request error: ${error.message}`)
    );
    req.setTimeout(10000, () => {
      req.destroy();
      this.log.warn("Alert polling request timeout");
    });
  }

  /**
   * Early Warning: category 13, specific title, recent, city match, deduped.
   */
  processEarlyWarningData(alerts) {
    if (!this.isAlertTypeActive(ALERT_TYPES.EARLY_WARNING)) return;
    if (!Array.isArray(alerts)) return;
    const now = Date.now();
    const cutoffTime = now - 60000;
    const alertsToProcess = alerts.filter((alert) => {
      if (!alert || alert.category !== 13) return false;
      if (alert.title !== ALERT_TITLES.EARLY_WARNING) return false;
      const alertDate = new Date(alert.alertDate).getTime();
      if (isNaN(alertDate) || alertDate < cutoffTime || alertDate > now + 10000)
        return false;
      const alertId = this.generateAlertId(alert);
      if (this.processedEarlyWarningAlerts.has(alertId)) return false;
      return true;
    });
    alertsToProcess.forEach((alert) =>
      this.processedEarlyWarningAlerts.add(this.generateAlertId(alert))
    );
    if (!alertsToProcess.length) return;
    const relevantAlerts = alertsToProcess.filter(
      (alert) =>
        alert.data === "ברחבי הארץ" ||
        this.selectedCities.length === 0 ||
        this.selectedCities.includes(alert.data)
    );
    if (!relevantAlerts.length) return;
    if (this.isAlertActive || this.isFlashAlertActive) return;
    const cities = relevantAlerts.map((alert) => alert.data);
    this.log.info(`EARLY WARNING TRIGGERED for areas: ${cities.join(", ")}`);
    this.triggerEarlyWarning(cities);
  }

  /**
   * Flash/Shelter: category 14, shelter/early-warning title, recent, city, deduped.
   */
  processFlashAlertData(alerts) {
    if (!this.isAlertTypeActive(ALERT_TYPES.FLASH_SHELTER)) return;
    if (!Array.isArray(alerts)) return;
    const now = Date.now();
    const cutoffTime = now - 60000;
    const alertsToProcess = alerts.filter((alert) => {
      if (!alert || alert.category !== 14) return false;
      if (
        ![ALERT_TITLES.FLASH_SHELTER, ALERT_TITLES.EARLY_WARNING].includes(
          alert.title
        )
      )
        return false;
      const alertDate = new Date(alert.alertDate).getTime();
      if (isNaN(alertDate) || alertDate < cutoffTime || alertDate > now + 10000)
        return false;
      const alertId = this.generateAlertId(alert);
      if (this.processedFlashAlerts.has(alertId)) return false;
      return true;
    });
    alertsToProcess.forEach((alert) =>
      this.processedFlashAlerts.add(this.generateAlertId(alert))
    );
    if (!alertsToProcess.length) return;
    const relevant = alertsToProcess.filter(
      (alert) =>
        alert.data === "ברחבי הארץ" ||
        this.selectedCities.length === 0 ||
        this.selectedCities.includes(alert.data)
    );
    if (!relevant.length) return;
    if (this.isAlertActive) return;
    if (this.isEarlyWarningActive) this.stopEarlyWarningPlayback();
    const cities = relevant.map((alert) => alert.data);
    this.log.info(`FLASH ALERT TRIGGERED for areas: ${cities.join(", ")}`);
    this.triggerFlashAlert(cities);
  }

  /**
   * Exit Notification: category 13, exit title, recent, city, deduped.
   */
  processExitNotificationData(alerts) {
    if (!this.isAlertTypeActive(ALERT_TYPES.EXIT_NOTIFICATION)) return;
    if (!Array.isArray(alerts)) return;
    const now = Date.now();
    const cutoffTime = now - 60000;
    const alertsToProcess = alerts.filter((alert) => {
      if (!alert || alert.category !== 13) return false;
      if (alert.title !== ALERT_TITLES.EXIT_NOTIFICATION) return false;
      const alertDate = new Date(alert.alertDate).getTime();
      if (isNaN(alertDate) || alertDate < cutoffTime || alertDate > now + 10000)
        return false;
      const alertId = this.generateAlertId(alert);
      if (this.processedExitNotifications.has(alertId)) return false;
      return true;
    });
    alertsToProcess.forEach((alert) =>
      this.processedExitNotifications.add(this.generateAlertId(alert))
    );
    if (!alertsToProcess.length) return;
    const relevant = alertsToProcess.filter(
      (alert) =>
        alert.data === "ברחבי הארץ" ||
        this.selectedCities.length === 0 ||
        this.selectedCities.includes(alert.data)
    );
    if (!relevant.length) return;
    const cities = relevant.map((alert) => alert.data);
    this.log.info(
      `EXIT NOTIFICATION TRIGGERED for areas: ${cities.join(", ")}`
    );
    this.triggerExitNotification(cities);
  }

  /**
   * Return true if alert type is enabled and within allowed hours.
   */
  isAlertTypeActive(type) {
    const cfg = this.alertsConfig[type];
    if (!cfg || !cfg.enabled) return false;
    const now = new Date();
    const hour = now.getHours();
    if (typeof cfg.startHour !== "number" || typeof cfg.endHour !== "number")
      return true;
    if (cfg.startHour === cfg.endHour) return true;
    if (cfg.startHour < cfg.endHour)
      return hour >= cfg.startHour && hour < cfg.endHour;
    return hour >= cfg.startHour || hour < cfg.endHour;
  }

  // --- Alert triggers and Chromecast playback (reset only when file finishes)

  triggerEarlyWarning(cities) {
    this.isEarlyWarningActive = true;
    this.earlyWarningActiveCities = cities;
    this.earlyWarningService.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );
    if (this.useChromecast) {
      this.playChromecastMedia(ALERT_TYPES.EARLY_WARNING, () =>
        this.resetEarlyWarning()
      );
    } else {
      // fallback: reset after timeout if no chromecast
      setTimeout(() => this.resetEarlyWarning(), this.chromecastTimeout * 1000);
    }
  }
  triggerFlashAlert(cities) {
    this.isFlashAlertActive = true;
    this.flashAlertActiveCities = cities;
    this.flashAlertService.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );
    if (this.useChromecast) {
      this.playChromecastMedia(ALERT_TYPES.FLASH_SHELTER, () =>
        this.resetFlashAlert()
      );
    } else {
      setTimeout(() => this.resetFlashAlert(), this.chromecastTimeout * 1000);
    }
  }
  triggerExitNotification(cities) {
    this.isExitNotificationActive = true;
    this.exitNotificationActiveCities = cities;
    this.exitNotificationService.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );
    if (this.useChromecast) {
      this.playChromecastMedia(ALERT_TYPES.EXIT_NOTIFICATION, () =>
        this.resetExitNotification()
      );
    } else {
      setTimeout(
        () => this.resetExitNotification(),
        this.chromecastTimeout * 1000
      );
    }
  }
  stopEarlyWarningPlayback() {
    this.resetEarlyWarning();
  }
  stopFlashAlertPlayback() {
    this.resetFlashAlert();
  }
  stopExitNotificationPlayback() {
    this.resetExitNotification();
  }
  resetEarlyWarning() {
    if (this.isEarlyWarningActive) {
      this.isEarlyWarningActive = false;
      this.earlyWarningActiveCities = [];
      this.earlyWarningService.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    }
    this.chromecastPlayingStatus[ALERT_TYPES.EARLY_WARNING].clear();
  }
  resetFlashAlert() {
    if (this.isFlashAlertActive) {
      this.isFlashAlertActive = false;
      this.flashAlertActiveCities = [];
      this.flashAlertService.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    }
    this.chromecastPlayingStatus[ALERT_TYPES.FLASH_SHELTER].clear();
  }
  resetExitNotification() {
    if (this.isExitNotificationActive) {
      this.isExitNotificationActive = false;
      this.exitNotificationActiveCities = [];
      this.exitNotificationService.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    }
    this.chromecastPlayingStatus[ALERT_TYPES.EXIT_NOTIFICATION].clear();
  }

  /**
   * Chromecast playback ends only when file ends: uses device 'finished' event.
   * Calls onAllComplete callback when all devices finished playback for this alert.
   */
  playChromecastMedia(alertType, onAllComplete) {
    if (!this.devices.length) {
      this.log.warn("No Chromecast devices available");
      if (onAllComplete) onAllComplete();
      return;
    }
    let mediaUrl;
    switch (alertType) {
      case ALERT_TYPES.PRIMARY:
        mediaUrl = `${this.baseUrl}/alert-video`;
        break;
      case ALERT_TYPES.TEST:
        mediaUrl = `${this.baseUrl}/test-video`;
        break;
      case ALERT_TYPES.EARLY_WARNING:
        mediaUrl = `${this.baseUrl}/early-warning-video`;
        break;
      case ALERT_TYPES.FLASH_SHELTER:
        mediaUrl = `${this.baseUrl}/flash-shelter-video`;
        break;
      case ALERT_TYPES.EXIT_NOTIFICATION:
        mediaUrl = `${this.baseUrl}/exit-notification-video`;
        break;
      default:
        this.log.error(`Unknown alert type: ${alertType}`);
        if (onAllComplete) onAllComplete();
        return;
    }

    // For multi-device, only reset state when all devices finished
    const devicesToWait = new Set();
    this.devices.forEach((device) => {
      const volume = this.getAlertVolume(alertType, device);
      devicesToWait.add(device.host);
      this.chromecastPlayingStatus[alertType].add(device.host);

      device.play(mediaUrl, (err, player) => {
        if (err) {
          this.log.error(
            `Failed to play on ${device.friendlyName}: ${err.message}`
          );
          devicesToWait.delete(device.host);
          this.chromecastPlayingStatus[alertType].delete(device.host);
          checkAllFinished();
          return;
        }
        device.setVolume(volume / 100, (err) => {
          if (err)
            this.log.warn(
              `Failed to set volume on ${device.friendlyName}: ${err.message}`
            );
        });
      });

      // Listen for 'finished' event on the device
      device.on("finished", () => {
        this.log.info(
          `Chromecast finished playback for ${alertType} on ${device.friendlyName}`
        );
        devicesToWait.delete(device.host);
        this.chromecastPlayingStatus[alertType].delete(device.host);
        checkAllFinished();
      });
    });

    // Helper: call onAllComplete() when all devices finished
    const checkAllFinished = () => {
      if (devicesToWait.size === 0 && typeof onAllComplete === "function") {
        this.log.info(
          `All Chromecast devices finished playback for ${alertType}`
        );
        onAllComplete();
      }
    };
  }

  // --- Chromecast discovery and per-device/per-alert volume

  setupChromecastDiscovery() {
    this.initializeChromecastClient();
    setInterval(() => {
      this.log.info("Reinitializing Chromecast client for rediscovery...");
      this.devices = [];
      this.initializeChromecastClient();
    }, 300000);
  }
  initializeChromecastClient() {
    this.chromecastClient = new ChromecastAPI();
    this.chromecastClient.on("device", (device) => {
      if (!device || !device.host || !device.friendlyName) return;
      if (
        typeof device.play !== "function" ||
        typeof device.setVolume !== "function"
      )
        return;
      if (!this.devices.some((d) => d.host === device.host))
        this.devices.push(device);
      this.log.info(
        `Chromecast discovered: ${device.friendlyName} at ${device.host}`
      );
    });
    this.chromecastClient.on("error", (err) => {
      this.log.error(`ChromecastAPI error: ${err.message}`);
    });
  }
  getAlertVolume(alertType, device) {
    const devName =
      device && device.friendlyName ? device.friendlyName.toLowerCase() : "";
    const devOverride = this.deviceOverrides[devName];
    if (
      devOverride &&
      devOverride.alerts[alertType] &&
      typeof devOverride.alerts[alertType].volume === "number"
    )
      return devOverride.alerts[alertType].volume;
    if (devOverride && typeof devOverride.volume === "number")
      return devOverride.volume;
    if (
      this.alertsConfig[alertType] &&
      typeof this.alertsConfig[alertType].volume === "number"
    )
      return this.alertsConfig[alertType].volume;
    return this.chromecastVolume;
  }

  // --- Media server for Chromecast file delivery

  setupMediaServer() {
    this.server = express();
    const mediaDir = path.join(this.api.user.storagePath(), "red-alert-media");
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
    this.server.get("/exit-notification-video", (req, res) =>
      res.sendFile(path.join(mediaDir, this.exitNotificationVideoPath))
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
  }
  copyDefaultMediaFiles() {
    const mediaDir = path.join(this.api.user.storagePath(), "red-alert-media");
    const pluginDir = path.join(__dirname, "media");
    if (fs.existsSync(pluginDir)) {
      fs.copySync(pluginDir, mediaDir, { overwrite: false });
      this.log.info("Default media files copied");
    }
  }

  // --- WebSocket for primary alerts

  setupWebSocket() {
    if (this.wsClient) this.wsClient.terminate();
    this.log.info(`Connecting to WebSocket: ${this.wsUrl}`);
    this.wsClient = new WebSocket(this.wsUrl);
    this.wsClient.on("open", () => {
      this.log.info("WebSocket connected");
      this.log.info(
        `Monitoring cities: ${this.selectedCities.join(", ") || "all"}`
      );
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    });
    this.wsClient.on("message", (data) =>
      this.handleAlertMessage(data.toString())
    );
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
  }
  scheduleReconnect() {
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
  }
  handleAlertMessage(message) {
    let alert;
    try {
      alert = JSON.parse(message);
    } catch (err) {
      this.log.warn(`Invalid JSON in WebSocket message: ${err.message}`);
      return;
    }
    if (!alert || !alert.areas || typeof alert.areas !== "string") {
      this.log.warn("Invalid alert message format");
      return;
    }
    const areas = alert.areas
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const relevantAreas = areas.filter(
      (area) =>
        area === "ברחבי הארץ" ||
        this.selectedCities.length === 0 ||
        this.selectedCities.includes(area)
    );
    const isTest = alert.alert_type === 0;

    if (relevantAreas.length > 0) {
      this.log.info(
        `PRIMARY ALERT triggered for areas: ${relevantAreas.join(", ")}`
      );
      if (this.isEarlyWarningActive) this.stopEarlyWarningPlayback();
      if (this.isFlashAlertActive) this.stopFlashAlertPlayback();
      if (this.isExitNotificationActive) this.stopExitNotificationPlayback();
      this.isAlertActive = true;
      this.alertActiveCities = relevantAreas;
      this.service.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      );
      if (this.useChromecast) {
        this.playChromecastMedia(
          isTest ? ALERT_TYPES.TEST : ALERT_TYPES.PRIMARY,
          () => {
            this.isAlertActive = false;
            this.alertActiveCities = [];
            this.service.updateCharacteristic(
              Characteristic.ContactSensorState,
              Characteristic.ContactSensorState.CONTACT_DETECTED
            );
          }
        );
      } else {
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
      }
    }
  }

  /**
   * Generate a unique alert ID for deduplication (timestamp_city_category_title)
   */
  generateAlertId(alert) {
    try {
      const alertDate = new Date(alert.alertDate);
      const sanitizedCity = String(alert.data || "unknown").replace(
        /[_]/g,
        "-"
      );
      const titleHash = alert.title ? alert.title.substring(0, 10) : "";
      return `${alertDate.getTime()}_${sanitizedCity}_${
        alert.category
      }_${titleHash}`;
    } catch (error) {
      this.log.error(`Error generating alert ID: ${error.message}`);
      return `${Date.now()}_unknown_${alert?.category || "unknown"}`;
    }
  }

  /**
   * Get the first non-internal IPv4 address, fallback to 127.0.0.1.
   */
  getIpAddress() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (!net.internal && net.family === "IPv4") {
          return net.address;
        }
      }
    }
    this.log.warn("No valid network interface found, using localhost");
    return "127.0.0.1";
  }
}

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerAccessory("homebridge-red-alert", "RedAlert", RedAlertPlugin);
};
