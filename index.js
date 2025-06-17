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
 * Author: Yali Hart & AI Friends (this is my first Homebridge plugin)
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
  alertVideoPath: "alert.mp4",
  earlyWarningVideoPath: "early.mp4",
  flashAlertShelterVideoPath: "flash-shelter.mp4",
  exitNotificationVideoPath: "exit.mp4",
  testVideoPath: "test.mp4",
  // Shelter instruction files
  ballisticClosureFile: "ballistic_closure.mp4",
  windowsClosedFile: "ballistic_windows_closed.mp4",
  shelterExitFile: "exit.mp4",
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

    // --- Shelter instructions ---
    const DEFAULT_SHELTER = {
      devices: [],
      primaryFile: "ballistic_closure.mp4",
      earlyWarningFile: "ballistic_windows_closed.mp4",
      flashShelterFile: "ballistic_windows_closed.mp4",
      exitFile: "exit.mp4",
      minIntervalMinutes: 20,
    };
    this.shelterInstructions = Object.assign(
      {},
      DEFAULT_SHELTER,
      config.shelterInstructions || {}
    );
    this.shelterInstructionsLastPlayed = {}; // { deviceName: { alertType: timestamp } }

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
        this.log.info("🚀 Initializing Red Alert plugin...");
        this.setupMediaServer();
        this.copyDefaultMediaFiles();
        if (this.useChromecast) this.setupChromecastDiscovery();
        this.setupWebSocket();
        this.setupEarlyWarningMonitoring();
        this.setupCleanupTimer();
        this.log.info("✅ Red Alert plugin initialization complete");
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
    this.log.debug(
      `⚙️ Parsed alert configs: ${JSON.stringify(result, null, 2)}`
    );
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
    this.log.debug(
      `⚙️ Parsed device overrides: ${JSON.stringify(result, null, 2)}`
    );
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
      this.log.info("🧪 Running alert test");
      this.triggerTest();
      setTimeout(() => {
        this.testSwitchService.updateCharacteristic(Characteristic.On, false);
      }, 2000);
    }
    callback(null);
  }

  triggerTest() {
    this.log.info(`🧪 TEST ALERT TRIGGERED`);
    this.isAlertActive = true;
    this.alertActiveCities =
      this.selectedCities.length > 0 ? [this.selectedCities[0]] : ["Test"];
    this.log.info(
      `📍 Test alert triggered for: ${this.alertActiveCities.join(", ")}`
    );
    this.service.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );
    if (this.useChromecast) {
      this.playChromecastMedia(ALERT_TYPES.TEST, () => {
        this.log.info("✅ Test alert playback completed, resetting state");
        this.isAlertActive = false;
        this.alertActiveCities = [];
        this.service.updateCharacteristic(
          Characteristic.ContactSensorState,
          Characteristic.ContactSensorState.CONTACT_DETECTED
        );
      });
    } else {
      setTimeout(() => {
        this.isAlertActive = false;
        this.alertActiveCities = [];
        this.log.info("✅ Test alert reset");
        this.service.updateCharacteristic(
          Characteristic.ContactSensorState,
          Characteristic.ContactSensorState.CONTACT_DETECTED
        );
      }, 10000);
    }
  }

  /**
   * Deduplication cleanup - remove old processed alert IDs hourly.
   */
  setupCleanupTimer() {
    this.log.info("🧹 Setting up cleanup timer (hourly)");
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
          this.log.debug(`🧹 Cleaned up ${removed} processed ${name} entries`);
      }
    }, 3600000);
  }

  /**
   * Poll OREF API for early warning / flash / exit notification every N seconds.
   */
  setupEarlyWarningMonitoring() {
    this.log.info(
      `📡 Setting up OREF monitoring (${this.earlyWarningPollInterval}ms interval)`
    );
    this.pollEarlyWarning();
    this.earlyWarningTimer = setInterval(
      () => this.pollEarlyWarning(),
      this.earlyWarningPollInterval
    );
  }

  pollEarlyWarning() {
    this.log.debug("📡 Polling OREF API for alerts...");
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
          this.log.warn(`⚠️ OREF API returned status: ${res.statusCode}`);
          return;
        }
        try {
          const parsedData = JSON.parse(data);
          this.log.debug(`📡 OREF API returned ${parsedData.length} alerts`);
          this.processEarlyWarningData(parsedData);
          this.processFlashAlertData(parsedData);
          this.processExitNotificationData(parsedData);
        } catch (err) {
          this.log.error(`❌ Error parsing alert data: ${err.message}`);
        }
      });
    });
    req.on("error", (error) =>
      this.log.error(`❌ Alert polling request error: ${error.message}`)
    );
    req.setTimeout(10000, () => {
      req.destroy();
      this.log.warn("⚠️ Alert polling request timeout");
    });
  }

  /**
   * Early Warning: category 13, specific title, recent, city match, deduped.
   */
  processEarlyWarningData(alerts) {
    if (!this.isAlertTypeActive(ALERT_TYPES.EARLY_WARNING)) {
      this.log.debug("⏸️ Early warning alerts disabled or outside time window");
      return;
    }
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
    if (!relevantAlerts.length) {
      this.log.debug(
        `🟡 Found ${alertsToProcess.length} early warning alerts, but none for monitored cities`
      );
      return;
    }
    if (this.isAlertActive || this.isFlashAlertActive) {
      this.log.info(
        `🟡 Early warning alerts found but skipped (primary/flash alert active)`
      );
      return;
    }
    const cities = relevantAlerts.map((alert) => alert.data);
    this.log.info(`🟡 EARLY WARNING TRIGGERED for areas: ${cities.join(", ")}`);
    this.triggerEarlyWarning(cities);
  }

  /**
   * Flash/Shelter: category 14, shelter/early-warning title, recent, city, deduped.
   */
  processFlashAlertData(alerts) {
    if (!this.isAlertTypeActive(ALERT_TYPES.FLASH_SHELTER)) {
      this.log.debug("⏸️ Flash alerts disabled or outside time window");
      return;
    }
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
    if (!relevant.length) {
      this.log.debug(
        `🔴 Found ${alertsToProcess.length} flash alerts, but none for monitored cities`
      );
      return;
    }
    if (this.isAlertActive) {
      this.log.info(`🔴 Flash alerts found but skipped (primary alert active)`);
      return;
    }
    if (this.isEarlyWarningActive) {
      this.log.info("🔴 Flash alert interrupting early warning");
      this.stopEarlyWarningPlayback();
    }
    const cities = relevant.map((alert) => alert.data);
    this.log.info(`🔴 FLASH ALERT TRIGGERED for areas: ${cities.join(", ")}`);
    this.triggerFlashAlert(cities);
  }

  /**
   * Exit Notification: category 13, exit title, recent, city, deduped.
   */
  processExitNotificationData(alerts) {
    if (!this.isAlertTypeActive(ALERT_TYPES.EXIT_NOTIFICATION)) {
      this.log.debug("⏸️ Exit notifications disabled or outside time window");
      return;
    }
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
    if (!relevant.length) {
      this.log.debug(
        `🟢 Found ${alertsToProcess.length} exit notifications, but none for monitored cities`
      );
      return;
    }
    const cities = relevant.map((alert) => alert.data);
    this.log.info(
      `🟢 EXIT NOTIFICATION TRIGGERED for areas: ${cities.join(", ")}`
    );
    this.triggerExitNotification(cities);
  }

  /**
   * Return true if alert type is enabled and within allowed hours.
   */
  isAlertTypeActive(type) {
    const cfg = this.alertsConfig[type];
    if (!cfg || !cfg.enabled) {
      this.log.debug(`⏸️ Alert type ${type} is disabled`);
      return false;
    }
    const now = new Date();
    const hour = now.getHours();
    if (typeof cfg.startHour !== "number" || typeof cfg.endHour !== "number") {
      this.log.debug(`⏰ Alert type ${type} has no time restrictions`);
      return true;
    }
    if (cfg.startHour === cfg.endHour) return true;

    let isWithinHours;
    if (cfg.startHour < cfg.endHour) {
      isWithinHours = hour >= cfg.startHour && hour < cfg.endHour;
    } else {
      isWithinHours = hour >= cfg.startHour || hour < cfg.endHour;
    }

    this.log.debug(
      `⏰ Alert type ${type} time check: ${hour}:00 (allowed: ${cfg.startHour}:00-${cfg.endHour}:00) = ${isWithinHours}`
    );
    return isWithinHours;
  }

  triggerEarlyWarning(cities) {
    this.log.info(`🟡 EARLY WARNING ALERT TRIGGERED`);
    this.log.info(`📍 Cities: ${cities.join(", ")}`);
    this.log.info(
      `⏰ Time: ${new Date().toLocaleString("en-US", {
        timeZone: "Asia/Jerusalem",
      })} (Israel time)`
    );

    this.isEarlyWarningActive = true;
    this.earlyWarningActiveCities = cities;
    this.earlyWarningService.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );

    if (this.useChromecast) {
      this.playChromecastMedia(ALERT_TYPES.EARLY_WARNING, () => {
        this.log.info(`✅ Early warning playback completed, resetting state`);
        this.resetEarlyWarning();
      });
    } else {
      this.log.info(
        `⏱️ Chromecast disabled, using ${this.chromecastTimeout}s timeout`
      );
      setTimeout(() => this.resetEarlyWarning(), this.chromecastTimeout * 1000);
    }
  }

  triggerFlashAlert(cities) {
    this.log.info(`🔴 FLASH/SHELTER ALERT TRIGGERED`);
    this.log.info(`📍 Cities: ${cities.join(", ")}`);
    this.log.info(
      `⏰ Time: ${new Date().toLocaleString("en-US", {
        timeZone: "Asia/Jerusalem",
      })} (Israel time)`
    );

    this.isFlashAlertActive = true;
    this.flashAlertActiveCities = cities;
    this.flashAlertService.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );

    if (this.useChromecast) {
      this.playChromecastMedia(ALERT_TYPES.FLASH_SHELTER, () => {
        this.log.info(`✅ Flash alert playback completed, resetting state`);
        this.resetFlashAlert();
      });
    } else {
      this.log.info(
        `⏱️ Chromecast disabled, using ${this.chromecastTimeout}s timeout`
      );
      setTimeout(() => this.resetFlashAlert(), this.chromecastTimeout * 1000);
    }
  }

  triggerExitNotification(cities) {
    this.log.info(`🟢 EXIT NOTIFICATION TRIGGERED`);
    this.log.info(`📍 Cities: ${cities.join(", ")}`);
    this.log.info(
      `⏰ Time: ${new Date().toLocaleString("en-US", {
        timeZone: "Asia/Jerusalem",
      })} (Israel time)`
    );

    this.isExitNotificationActive = true;
    this.exitNotificationActiveCities = cities;
    this.exitNotificationService.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );

    if (this.useChromecast) {
      this.playChromecastMedia(ALERT_TYPES.EXIT_NOTIFICATION, () => {
        this.log.info(
          `✅ Exit notification playback completed, resetting state`
        );
        this.resetExitNotification();
      });
    } else {
      this.log.info(
        `⏱️ Chromecast disabled, using ${this.chromecastTimeout}s timeout`
      );
      setTimeout(
        () => this.resetExitNotification(),
        this.chromecastTimeout * 1000
      );
    }
  }

  stopEarlyWarningPlayback() {
    this.log.info("🛑 Stopping early warning playback");
    this.resetEarlyWarning();
  }

  stopFlashAlertPlayback() {
    this.log.info("🛑 Stopping flash alert playback");
    this.resetFlashAlert();
  }

  stopExitNotificationPlayback() {
    this.log.info("🛑 Stopping exit notification playback");
    this.resetExitNotification();
  }

  resetEarlyWarning() {
    if (this.isEarlyWarningActive) {
      this.log.info("🔄 Resetting early warning state");
      this.isEarlyWarningActive = false;
      this.earlyWarningActiveCities = [];
      this.earlyWarningService.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    }
  }

  resetFlashAlert() {
    if (this.isFlashAlertActive) {
      this.log.info("🔄 Resetting flash alert state");
      this.isFlashAlertActive = false;
      this.flashAlertActiveCities = [];
      this.flashAlertService.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    }
  }

  resetExitNotification() {
    if (this.isExitNotificationActive) {
      this.log.info("🔄 Resetting exit notification state");
      this.isExitNotificationActive = false;
      this.exitNotificationActiveCities = [];
      this.exitNotificationService.updateCharacteristic(
        Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    }
  }

  /**
   * Chromecast playback with shelter instructions logic and comprehensive logging.
   */
  playChromecastMedia(alertType, onAllComplete) {
    this.log.info(
      `🎵 Starting Chromecast playback for alert type: ${alertType}`
    );

    if (!this.devices.length) {
      this.log.warn("❌ No Chromecast devices available");
      if (onAllComplete) onAllComplete();
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
      this.log.warn("❌ No valid Chromecast devices available after filtering");
      if (onAllComplete) onAllComplete();
      return;
    }

    this.log.info(
      `📱 Found ${validDevices.length} valid Chromecast devices: ${validDevices
        .map((d) => d.friendlyName)
        .join(", ")}`
    );

    // Separate shelter and regular devices
    const shelterDevices = [];
    const regularDevices = [];

    validDevices.forEach((device) => {
      const shelterCfg = (this.shelterInstructions.devices || []).find(
        (s) =>
          s.deviceName &&
          device.friendlyName &&
          s.deviceName.trim().toLowerCase() ===
            device.friendlyName.trim().toLowerCase() &&
          s.enabled !== false
      );

      if (shelterCfg) {
        shelterDevices.push({ device, config: shelterCfg });
        this.log.info(`🏠 [Shelter] Device identified: ${device.friendlyName}`);
      } else {
        regularDevices.push(device);
        this.log.info(`📺 [Regular] Device identified: ${device.friendlyName}`);
      }
    });

    // Process shelter devices
    shelterDevices.forEach(({ device, config }) => {
      let mediaUrl,
        volume,
        shouldPlay = true;

      // Check cooldown for certain alert types
      if (
        alertType === ALERT_TYPES.EARLY_WARNING ||
        alertType === ALERT_TYPES.FLASH_SHELTER
      ) {
        if (!this.canPlayShelterInstructions(device.friendlyName, alertType)) {
          this.log.info(
            `🏠 [Shelter] Skipping ${alertType} on ${device.friendlyName} - cooldown active (${this.shelterInstructions.minIntervalMinutes} min)`
          );
          shouldPlay = false;
        } else {
          this.markShelterInstructionsPlayed(device.friendlyName, alertType);
          this.log.info(
            `🏠 [Shelter] Cooldown OK for ${alertType} on ${device.friendlyName}`
          );
        }
      }

      if (shouldPlay) {
        switch (alertType) {
          case ALERT_TYPES.PRIMARY:
            mediaUrl = `${this.baseUrl}/shelter-instructions-primary`;
            volume = config.volumes?.primary || 50;
            this.log.info(
              `🏠 [Shelter] PRIMARY alert - playing closure instructions on ${device.friendlyName}`
            );
            this.markShelterInstructionsPlayed(device.friendlyName, "primary");
            break;
          case ALERT_TYPES.EARLY_WARNING:
            mediaUrl = `${this.baseUrl}/shelter-instructions-early-warning`;
            volume = config.volumes?.["early-warning"] || 60;
            this.log.info(
              `🏠 [Shelter] EARLY WARNING - playing windows closed instructions on ${device.friendlyName}`
            );
            break;
          case ALERT_TYPES.FLASH_SHELTER:
            mediaUrl = `${this.baseUrl}/shelter-instructions-flash-shelter`;
            volume = config.volumes?.["flash-shelter"] || 60;
            this.log.info(
              `🏠 [Shelter] FLASH SHELTER - playing windows closed instructions on ${device.friendlyName}`
            );
            break;
          case ALERT_TYPES.EXIT_NOTIFICATION:
            mediaUrl = `${this.baseUrl}/shelter-instructions-exit-notification`;
            volume = config.volumes?.["exit-notification"] || 60;
            this.log.info(
              `🏠 [Shelter] EXIT NOTIFICATION - playing exit instructions on ${device.friendlyName}`
            );
            this.markShelterInstructionsPlayed(
              device.friendlyName,
              "exit-notification"
            );
            break;
          case ALERT_TYPES.TEST:
            mediaUrl = `${this.baseUrl}/test-video`;
            volume = config.volumes?.primary || 50;
            this.log.info(`🏠 [Shelter] TEST alert on ${device.friendlyName}`);
            break;
          default:
            this.log.error(
              `❌ Unknown alert type for shelter device: ${alertType}`
            );
            return;
        }

        this.log.info(
          `🏠 [Shelter] Playing ${alertType} on ${device.friendlyName} at ${volume}% volume`
        );
        this.playWithRetry(device, mediaUrl, 3, alertType, volume, true);
      }
    });

    // Process regular devices
    if (regularDevices.length > 0) {
      let mediaUrl;
      switch (alertType) {
        case ALERT_TYPES.PRIMARY:
          mediaUrl = `${this.baseUrl}/alert-video`;
          this.log.info(
            `📺 [Regular] PRIMARY alert - playing standard alert video`
          );
          break;
        case ALERT_TYPES.TEST:
          mediaUrl = `${this.baseUrl}/test-video`;
          this.log.info(`📺 [Regular] TEST alert - playing test video`);
          break;
        case ALERT_TYPES.EARLY_WARNING:
          mediaUrl = `${this.baseUrl}/early-warning-video`;
          this.log.info(
            `📺 [Regular] EARLY WARNING - playing early warning video`
          );
          break;
        case ALERT_TYPES.FLASH_SHELTER:
          mediaUrl = `${this.baseUrl}/flash-shelter-video`;
          this.log.info(
            `📺 [Regular] FLASH SHELTER - playing flash shelter video`
          );
          break;
        case ALERT_TYPES.EXIT_NOTIFICATION:
          mediaUrl = `${this.baseUrl}/exit-notification-video`;
          this.log.info(
            `📺 [Regular] EXIT NOTIFICATION - playing exit notification video`
          );
          break;
        default:
          this.log.error(
            `❌ Unknown alert type for regular devices: ${alertType}`
          );
          return;
      }

      regularDevices.forEach((device) => {
        const volume = this.getAlertVolume(alertType, device);
        this.log.info(
          `📺 [Regular] Playing ${alertType} on ${device.friendlyName} at ${volume}% volume`
        );
        this.playWithRetry(device, mediaUrl, 3, alertType, volume, false);
      });
    }

    // Simple timeout fallback like your original working code
    const timeoutMs = this.chromecastTimeout * 1000;
    this.log.info(
      `⏱️ Setting ${this.chromecastTimeout}s timeout for ${alertType} completion`
    );
    setTimeout(() => {
      this.log.info(
        `✅ Timeout reached for ${alertType} - calling completion callback`
      );
      if (onAllComplete) onAllComplete();
    }, timeoutMs);
  }

  playWithRetry(
    device,
    mediaUrl,
    retries,
    alertType,
    volume,
    isShelter = false
  ) {
    const deviceType = isShelter ? "🏠 [Shelter]" : "📺 [Regular]";
    this.log.debug(
      `${deviceType} Attempting playback on ${device.friendlyName} (${device.host})`
    );
    this.log.debug(`${deviceType} Media URL: ${mediaUrl}`);
    this.log.debug(`${deviceType} Target volume: ${volume}%`);

    device.play(mediaUrl, (err) => {
      if (err && retries > 0) {
        this.log.warn(
          `${deviceType} ⚠️ Playback failed on ${device.friendlyName}, retrying (${retries} attempts left): ${err.message}`
        );
        setTimeout(
          () =>
            this.playWithRetry(
              device,
              mediaUrl,
              retries - 1,
              alertType,
              volume,
              isShelter
            ),
          2000
        );
      } else if (err) {
        this.log.error(
          `${deviceType} ❌ Final playback failure on ${device.friendlyName}: ${err.message}`
        );
      } else {
        this.log.info(
          `${deviceType} ▶️ Successfully started playback on ${device.friendlyName}`
        );
        this.log.debug(
          `${deviceType} Now setting volume to ${volume}% on ${device.friendlyName}`
        );

        device.setVolume(volume / 100, (volErr) => {
          if (volErr) {
            this.log.warn(
              `${deviceType} ⚠️ Failed to set volume on ${device.friendlyName}: ${volErr.message}`
            );
          } else {
            this.log.info(
              `${deviceType} 🔊 Volume set to ${volume}% on ${device.friendlyName}`
            );
          }
        });
      }
    });
  }

  canPlayShelterInstructions(deviceName, alertType) {
    const minInterval =
      (this.shelterInstructions.minIntervalMinutes || 20) * 60 * 1000;
    const now = Date.now();
    if (!this.shelterInstructionsLastPlayed[deviceName])
      this.shelterInstructionsLastPlayed[deviceName] = {};
    const last = this.shelterInstructionsLastPlayed[deviceName][alertType] || 0;
    const canPlay = now - last > minInterval;

    if (!canPlay) {
      const minutesLeft = Math.ceil((minInterval - (now - last)) / 60000);
      this.log.debug(
        `🏠 [Shelter] Cooldown check for ${deviceName}/${alertType}: ${minutesLeft} minutes remaining`
      );
    }

    return canPlay;
  }

  markShelterInstructionsPlayed(deviceName, alertType) {
    if (!this.shelterInstructionsLastPlayed[deviceName])
      this.shelterInstructionsLastPlayed[deviceName] = {};
    this.shelterInstructionsLastPlayed[deviceName][alertType] = Date.now();
    this.log.debug(
      `🏠 [Shelter] Marked ${alertType} as played on ${deviceName} at ${new Date().toISOString()}`
    );
  }

  setupChromecastDiscovery() {
    this.log.info("🔍 Setting up Chromecast discovery...");
    this.initializeChromecastClient();
    setInterval(() => {
      this.log.info("🔄 Reinitializing Chromecast client for rediscovery...");
      this.devices = [];
      this.initializeChromecastClient();
    }, 300000);
  }

  initializeChromecastClient() {
    try {
      this.chromecastClient = new ChromecastAPI();
      this.chromecastClient.on("device", (device) => {
        if (!device || !device.host || !device.friendlyName) {
          this.log.warn(`⚠️ Invalid Chromecast device data received`);
          return;
        }
        if (
          typeof device.play !== "function" ||
          typeof device.setVolume !== "function"
        ) {
          this.log.warn(
            `⚠️ Chromecast '${device.friendlyName}' lacks required functions`
          );
          return;
        }
        if (!this.devices.some((d) => d.host === device.host)) {
          this.devices.push(device);
          this.log.info(
            `✅ Chromecast discovered: ${device.friendlyName} at ${device.host}`
          );
        } else {
          this.log.debug(
            `🔄 Chromecast rediscovered: ${device.friendlyName} at ${device.host}`
          );
        }
      });
      this.chromecastClient.on("error", (err) => {
        this.log.error(`❌ ChromecastAPI error: ${err.message}`);
      });
    } catch (error) {
      this.log.error(`❌ Failed to initialize Chromecast: ${error.message}`);
      this.useChromecast = false;
      this.devices = [];
      this.log.warn(
        "⚠️ Chromecast functionality disabled due to initialization failure"
      );
    }
  }

  getAlertVolume(alertType, device) {
    const devName =
      device && device.friendlyName ? device.friendlyName.toLowerCase() : "";
    const devOverride = this.deviceOverrides[devName];

    let volume = this.chromecastVolume; // default
    let source = "default";

    if (
      devOverride &&
      devOverride.alerts[alertType] &&
      typeof devOverride.alerts[alertType].volume === "number"
    ) {
      volume = devOverride.alerts[alertType].volume;
      source = `device-specific ${alertType}`;
    } else if (devOverride && typeof devOverride.volume === "number") {
      volume = devOverride.volume;
      source = "device-specific default";
    } else if (
      this.alertsConfig[alertType] &&
      typeof this.alertsConfig[alertType].volume === "number"
    ) {
      volume = this.alertsConfig[alertType].volume;
      source = `alert-type ${alertType}`;
    }

    this.log.debug(
      `📺 [Volume] ${device.friendlyName}: ${volume}% (source: ${source})`
    );
    return volume;
  }

  setupMediaServer() {
    try {
      this.log.info(`🌐 Setting up media server on port ${this.serverPort}...`);
      this.server = express();
      const mediaDir = path.join(
        this.api.user.storagePath(),
        "red-alert-media"
      );
      fs.ensureDirSync(mediaDir);
      this.server.use(express.static(mediaDir));

      this.server.get("/alert-video", (req, res) => {
        this.log.debug("📹 Serving alert video");
        res.sendFile(path.join(mediaDir, this.alertVideoPath));
      });
      this.server.get("/test-video", (req, res) => {
        this.log.debug("📹 Serving test video");
        res.sendFile(path.join(mediaDir, this.testVideoPath));
      });
      this.server.get("/early-warning-video", (req, res) => {
        this.log.debug("📹 Serving early warning video");
        res.sendFile(path.join(mediaDir, this.earlyWarningVideoPath));
      });
      this.server.get("/flash-shelter-video", (req, res) => {
        this.log.debug("📹 Serving flash shelter video");
        res.sendFile(path.join(mediaDir, this.flashAlertShelterVideoPath));
      });
      this.server.get("/exit-notification-video", (req, res) => {
        this.log.debug("📹 Serving exit notification video");
        res.sendFile(path.join(mediaDir, this.exitNotificationVideoPath));
      });

      // Shelter instructions endpoints
      this.server.get("/shelter-instructions-primary", (req, res) => {
        this.log.debug("🏠 Serving primary shelter instructions");
        res.sendFile(
          path.join(
            mediaDir,
            this.shelterInstructions.primaryFile ||
              this.ballisticClosureFile ||
              "ballistic_closure.mp4"
          )
        );
      });
      this.server.get("/shelter-instructions-early-warning", (req, res) => {
        this.log.debug("🏠 Serving early warning shelter instructions");
        res.sendFile(
          path.join(
            mediaDir,
            this.shelterInstructions.earlyWarningFile ||
              this.windowsClosedFile ||
              "ballistic_windows_closed.mp4"
          )
        );
      });
      this.server.get("/shelter-instructions-flash-shelter", (req, res) => {
        this.log.debug("🏠 Serving flash shelter instructions");
        res.sendFile(
          path.join(
            mediaDir,
            this.shelterInstructions.flashShelterFile ||
              this.windowsClosedFile ||
              "ballistic_windows_closed.mp4"
          )
        );
      });
      this.server.get("/shelter-instructions-exit-notification", (req, res) => {
        this.log.debug("🏠 Serving exit notification shelter instructions");
        res.sendFile(
          path.join(
            mediaDir,
            this.shelterInstructions.exitFile ||
              this.shelterExitFile ||
              "exit.mp4"
          )
        );
      });

      this.server.get("/health", (req, res) => {
        this.log.debug("💚 Media server health check");
        res.status(200).send("OK");
      });

      this.server
        .listen(this.serverPort, () => {
          this.log.info(`✅ Media server running on ${this.baseUrl}`);
        })
        .on("error", (err) => {
          this.log.error(`❌ Media server error: ${err.message}`);
        });
    } catch (error) {
      this.log.error(`❌ Failed to setup media server: ${error.message}`);
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
        this.log.info("📁 Default media files copied");
      } else {
        this.log.warn("⚠️ No default media directory found");
      }
    } catch (error) {
      this.log.error(`❌ Error copying media files: ${error.message}`);
    }
  }

  setupWebSocket() {
    if (this.wsClient) {
      this.log.debug("🔌 Terminating existing WebSocket connection");
      this.wsClient.terminate();
    }
    this.log.info(`🔌 Connecting to WebSocket: ${this.wsUrl}`);
    this.wsClient = new WebSocket(this.wsUrl);

    this.wsClient.on("open", () => {
      this.log.info("✅ WebSocket connected");
      this.log.info(
        `👀 Monitoring cities: ${this.selectedCities.join(", ") || "all"}`
      );
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });

    this.wsClient.on("message", (data) => {
      this.handleAlertMessage(data.toString());
    });

    this.wsClient.on("error", (error) => {
      this.log.error(`❌ WebSocket error: ${error.message}`);
      this.scheduleReconnect();
    });

    this.wsClient.on("close", () => {
      this.log.warn("⚠️ WebSocket connection closed");
      this.scheduleReconnect();
    });

    const pingInterval = setInterval(() => {
      if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
        this.wsClient.ping();
        this.log.debug("🏓 WebSocket ping sent");
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);
  }

  scheduleReconnect() {
    if (!this.reconnectTimer) {
      this.log.info(
        `🔄 Scheduling WebSocket reconnect in ${
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
    this.log.debug(
      `📡 WebSocket message received: ${message.substring(0, 100)}...`
    );

    let alert;
    try {
      alert = JSON.parse(message);
    } catch (err) {
      this.log.warn(`❌ Invalid JSON in WebSocket message: ${err.message}`);
      return;
    }

    if (!alert || !alert.areas || typeof alert.areas !== "string") {
      this.log.warn("❌ Invalid alert message format");
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

    this.log.debug(`📡 Alert areas: ${areas.join(", ")}`);
    this.log.debug(`📍 Relevant areas: ${relevantAreas.join(", ")}`);
    this.log.debug(`🧪 Is test: ${isTest}`);

    if (relevantAreas.length > 0) {
      this.log.info(`🚨 PRIMARY ALERT TRIGGERED`);
      this.log.info(`📍 Areas: ${relevantAreas.join(", ")}`);
      this.log.info(
        `⏰ Time: ${new Date().toLocaleString("en-US", {
          timeZone: "Asia/Jerusalem",
        })} (Israel time)`
      );
      this.log.info(`🧪 Alert Type: ${isTest ? "TEST" : "REAL"}`);

      if (this.isEarlyWarningActive) {
        this.log.info("🟡 Stopping early warning for primary alert");
        this.stopEarlyWarningPlayback();
      }
      if (this.isFlashAlertActive) {
        this.log.info("🔴 Stopping flash alert for primary alert");
        this.stopFlashAlertPlayback();
      }
      if (this.isExitNotificationActive) {
        this.log.info("🟢 Stopping exit notification for primary alert");
        this.stopExitNotificationPlayback();
      }

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
            this.log.info(
              `✅ Primary alert playback completed, resetting state`
            );
            this.isAlertActive = false;
            this.alertActiveCities = [];
            this.service.updateCharacteristic(
              Characteristic.ContactSensorState,
              Characteristic.ContactSensorState.CONTACT_DETECTED
            );
          }
        );
      } else {
        this.log.info(
          `⏱️ Chromecast disabled, using ${this.chromecastTimeout}s timeout`
        );
        setTimeout(() => {
          if (this.isAlertActive) {
            this.log.info("✅ Auto-resetting primary alert state");
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
      this.log.error(`❌ Error generating alert ID: ${error.message}`);
      return `${Date.now()}_unknown_${alert?.category || "unknown"}`;
    }
  }

  /**
   * Get the first non-internal IPv4 address, fallback to 127.0.0.1.
   */
  getIpAddress() {
    try {
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (!net.internal && net.family === "IPv4") {
            this.log.debug(`🌐 Using IP address: ${net.address}`);
            return net.address;
          }
        }
      }
      this.log.warn("⚠️ No valid network interface found, using localhost");
      return "127.0.0.1";
    } catch (error) {
      this.log.error(`❌ Error getting IP address: ${error.message}`);
      return "127.0.0.1";
    }
  }
}

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerAccessory("homebridge-red-alert", "RedAlert", RedAlertPlugin);
};
