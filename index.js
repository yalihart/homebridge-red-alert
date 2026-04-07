/**
 * Homebridge Red Alert Plugin with Full Tzofar WebSocket Integration
 * Monitors Israeli Home Front Command alerts exclusively via Tzofar WebSocket
 *
 * Features:
 * - Tzofar WebSocket for ALL alert types (primary, early warnings, exit notifications)
 * - Per-alert-type enable/time/volume controls with time restrictions
 * - Per-device, per-alert-type volume
 * - City filtering with ID-based matching
 * - 2-minute debounce for duplicate alerts
 * - Enhanced validation with Hebrew keywords
 * - Shelter instruction devices with cooldown periods
 * - Reliable Chromecast integration
 * - Nationwide alert support (city ID 10000000)
 *
 * Author: Yali Hart & AI Friends
 * License: MIT
 */

const WebSocket = require("ws");
const fs = require("fs-extra");
const path = require("path");
const express = require("express");
const compression = require("compression");
const ChromecastAPI = require("chromecast-api");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

let Service, Characteristic, UUIDGen;

// Global reference to camera platform for triggering doorbell from accessory
let cameraPlatformInstance = null;

// Alert types and their canonical titles (in Hebrew)
const ALERT_TYPES = {
  PRIMARY: "primary",
  TEST: "test",
  EARLY_WARNING: "early-warning",
  EXIT_NOTIFICATION: "exit-notification",
};

// Special city ID for nationwide alerts
const NATIONWIDE_CITY_ID = 10000000;

// Threat ID mapping for Tzofar alerts
const THREAT_ID_MAPPING = {
  2: {
    type: ALERT_TYPES.PRIMARY,
    name: "Fear of Terrorists Infiltration",
    priority: 1,
  },
  7: {
    type: ALERT_TYPES.PRIMARY,
    name: "Non-conventional Missile",
    priority: 2,
  },
  5: {
    type: ALERT_TYPES.PRIMARY,
    name: "Hostile Aircraft Intrusion",
    priority: 5,
  },
  0: { type: ALERT_TYPES.PRIMARY, name: "Red Alert", priority: 8 },
};

// Early warning validation keywords (Hebrew only)
const EARLY_WARNING_KEYWORDS = [
  "בדקות הקרובות",
  "צפויות להתקבל התרעות",
  "ייתכן ויופעלו התרעות",
  "זיהוי שיגורים",
  "שיגורים לעבר ישראל",
  "בעקבות זיהוי שיגורים",
];

// Exit notification validation keywords (Hebrew only)
const EXIT_NOTIFICATION_KEYWORDS = [
  "האירוע הסתיים",
  "הסתיים באזורים",
  "האירוע הסתיים באזורים",
];

const DEFAULT_ALERTS_CONFIG = {
  [ALERT_TYPES.EARLY_WARNING]: {
    enabled: true,
    volume: 60,
  },
  [ALERT_TYPES.EXIT_NOTIFICATION]: {
    enabled: true,
    volume: 45,
  },
};

const DEFAULT_MEDIA_PATHS = {
  alertVideoPath: "alert.mp4",
  earlyWarningVideoPath: "early.mp4",
  exitNotificationVideoPath: "exit.mp4",
  testVideoPath: "test.mp4",
  ballisticClosureFile: "ballistic_closure.mp4",
  windowsClosedFile: "ballistic_windows_closed.mp4",
  shelterExitFile: "exit.mp4",
};

// Debounce time
const ALERT_DEBOUNCE_TIME = 2 * 60 * 1000; // 2 minutes

class TzofarWebSocketClient {
  constructor(plugin) {
    this.plugin = plugin;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.pingInterval = null;
    this.pongTimeout = null;
    this.shouldReconnect = true;
    this.reconnectTimer = null;
  }

  generateTzofar() {
    return crypto.randomBytes(16).toString("hex");
  }

  connect() {
    this.plugin.log.info(
      `🔌 Connecting to Tzofar WebSocket: ${this.plugin.tzofar.wsUrl}`
    );

    this.ws = new WebSocket(this.plugin.tzofar.wsUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36",
        Referer: "https://www.tzevaadom.co.il",
        Origin: "https://www.tzevaadom.co.il",
        tzofar: this.generateTzofar(),
      },
    });

    this.ws.on("open", () => {
      this.plugin.log.info("✅ Tzofar WebSocket connected");
      this.reconnectAttempts = 0;
      this.startPingPong();
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });

    this.ws.on("message", (data) => {
      const message = data.toString();
      if (message.length > 0) {
        this.plugin.log.debug(
          `📡 Tzofar message: ${message.substring(0, 100)}...`
        );
        this.handleMessage(message);
      }
      this.resetPongTimeout();
    });

    this.ws.on("pong", () => {
      this.plugin.log.debug("🏓 Received pong from Tzofar");
      this.resetPongTimeout();
    });

    this.ws.on("error", (error) => {
      this.plugin.log.error(`❌ Tzofar WebSocket error: ${error.message}`);
    });

    this.ws.on("close", (code, reason) => {
      this.plugin.log.warn(
        `⚠️ Tzofar WebSocket closed: Code ${code}, Reason: ${reason.toString()}`
      );
      this.stopPingPong();
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });
  }

  handleMessage(message) {
    try {
      const data = JSON.parse(message);
      this.plugin.log.debug(`📡 Received Tzofar message type: ${data.type}`);

      if (data.type === "ALERT") {
        this.plugin.log.info(
          `🚨 Processing ALERT: ${JSON.stringify(data.data)}`
        );
        this.plugin.handlePrimaryAlert(data.data);
      } else if (data.type === "SYSTEM_MESSAGE") {
        this.plugin.log.info(
          `🟡 Processing SYSTEM_MESSAGE: ${JSON.stringify(data.data)}`
        );
        this.plugin.handleSystemMessage(data.data);
      } else {
        this.plugin.log.debug(
          `📋 Unknown Tzofar message type: ${
            data.type
          } - Full data: ${JSON.stringify(data)}`
        );
      }
    } catch (error) {
      this.plugin.log.warn(
        `❌ Invalid JSON in Tzofar message: ${error.message}`
      );
      this.plugin.log.debug(`❌ Raw message: ${message}`);
    }
  }

  startPingPong() {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.plugin.log.debug("🏓 Sending ping to Tzofar");
        this.ws.ping();
      }
    }, this.plugin.tzofar.pingInterval);

    this.resetPongTimeout();
  }

  resetPongTimeout() {
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
    }
    this.pongTimeout = setTimeout(() => {
      this.plugin.log.warn("⚠️ Pong timeout from Tzofar, closing connection");
      if (this.ws) {
        this.ws.terminate();
      }
    }, this.plugin.tzofar.pongTimeout);
  }

  stopPingPong() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.shouldReconnect) return;

    const currentInterval = Math.min(
      this.plugin.tzofar.reconnectInterval *
        Math.pow(1.5, this.reconnectAttempts),
      this.plugin.tzofar.maxReconnectInterval
    );

    if (this.reconnectAttempts >= this.plugin.tzofar.maxReconnectAttempts) {
      this.plugin.log.error("❌ Max Tzofar reconnect attempts reached");
      return;
    }

    this.plugin.log.info(
      `🔄 Scheduling Tzofar reconnect in ${currentInterval / 1000}s (attempt ${
        this.reconnectAttempts + 1
      })`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect();
    }, currentInterval);
  }

  disconnect() {
    this.shouldReconnect = false;
    this.stopPingPong();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.terminate();
    }
  }
}

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
    this.baseUrl =
      config.baseUrl || `http://${this.getIpAddress()}:${this.serverPort}`;

    // --- Tzofar WebSocket configuration
    this.tzofar = {
      enabled: config.tzofar?.enabled !== false,
      wsUrl:
        config.tzofar?.wsUrl ||
        "wss://ws.tzevaadom.co.il/socket?platform=ANDROID",
      reconnectInterval: config.tzofar?.reconnectInterval || 10000,
      maxReconnectInterval: config.tzofar?.maxReconnectInterval || 60000,
      maxReconnectAttempts: config.tzofar?.maxReconnectAttempts || 10,
      pingInterval: config.tzofar?.pingInterval || 60000,
      pongTimeout: config.tzofar?.pongTimeout || 420000,
    };

    // --- Cities data management
    this.citiesJsonPath =
      config.citiesJsonPath || path.join(__dirname, "cities.json");
    this.citiesData = null;
    this.cityNameToId = new Map();

    // --- Debounce and tracking systems
    this.alertDebounce = new Map(); // key: "alertType_cityName", value: timestamp
    this.lastAlertTypePerCity = new Map(); // key: "cityName", value: { alertType, timestamp }

    // --- Per-alert-type config (enable, time, volume)
    this.alertsConfig = this.parseAlertsConfig(config);

    // --- Per-device, per-alert volume
    this.chromecastVolumes = Array.isArray(config.chromecastVolumes)
      ? config.chromecastVolumes
      : [];
    this.deviceOverrides = this.parseDeviceOverrides(this.chromecastVolumes);

    // --- Shelter instructions
    const DEFAULT_SHELTER = {
      devices: [],
      primaryFile: "ballistic_closure.mp4",
      earlyWarningFile: "ballistic_windows_closed.mp4",
      exitFile: "exit.mp4",
      minIntervalMinutes: 20,
    };
    this.shelterInstructions = Object.assign(
      {},
      DEFAULT_SHELTER,
      config.shelterInstructions || {}
    );
    this.shelterInstructionsLastPlayed = {}; // { deviceName: { alertType: timestamp } }

    // --- State for HomeKit
    this.isAlertActive = false;
    this.isEarlyWarningActive = false;
    this.isExitNotificationActive = false;
    this.alertActiveCities = [];
    this.earlyWarningActiveCities = [];
    this.exitNotificationActiveCities = [];
    this.tzofarClient = null;
    this.devices = [];

    // --- Apple TV Doorbell Configuration
    this.useAppleTVDoorbell = config.appleTVDoorbell?.enabled === true;
    this.doorbellThrottle = (config.appleTVDoorbell?.throttleSeconds || 10) * 1000;
    this.lastDoorbellRing = 0;

    // --- HomeKit services
    this.service = new Service.ContactSensor(this.name);

    // Test switch for triggering test alerts
    this.testSwitchService = new Service.Switch(`${this.name} Test`, "test");
    this.testSwitchService
      .getCharacteristic(Characteristic.On)
      .on("set", this.handleTestSwitch.bind(this));

    this.earlyWarningService = new Service.ContactSensor(
      `${this.name} Early Warning`,
      "early-warning"
    );
    this.exitNotificationService = new Service.ContactSensor(
      `${this.name} Exit Notification`,
      "exit-notification"
    );

    // --- Startup logic
    if (this.api) {
      this.api.on("didFinishLaunching", async () => {
        this.log.info("🚀 Initializing Red Alert plugin with Tzofar...");

        // Load cities data for Tzofar mode
        const citiesLoaded = await this.loadCitiesData();
        if (!citiesLoaded) {
          this.log.error("❌ Cannot start without cities data");
          return;
        }

        this.setupMediaServer();
        this.copyDefaultMediaFiles();
        if (this.useChromecast) this.setupChromecastDiscovery();

        this.setupTzofarWebSocket();
        this.setupCleanupTimer();

        this.log.info("✅ Red Alert plugin initialization complete");
      });
    }
  }

  // Cities data management
  async loadCitiesData() {
    try {
      this.log.info("📍 Loading cities data...");

      if (!fs.existsSync(this.citiesJsonPath)) {
        this.log.error(`❌ Cities file not found: ${this.citiesJsonPath}`);
        return false;
      }

      const citiesRaw = await fs.readFile(this.citiesJsonPath, "utf8");
      const citiesData = JSON.parse(citiesRaw);

      if (!citiesData.cities) {
        this.log.error(
          "❌ Invalid cities data format - missing 'cities' property"
        );
        return false;
      }

      this.citiesData = citiesData.cities;

      // Create reverse lookup map: city name -> city ID
      this.cityNameToId.clear();
      for (const [cityName, cityInfo] of Object.entries(this.citiesData)) {
        this.cityNameToId.set(cityName, cityInfo.id);
      }

      this.log.info(`✅ Loaded ${Object.keys(this.citiesData).length} cities`);

      // Validate configured cities
      const invalidCities = this.selectedCities.filter(
        (city) => !this.cityNameToId.has(city)
      );
      if (invalidCities.length > 0) {
        this.log.warn(
          `⚠️ Invalid cities in config: ${invalidCities.join(", ")}`
        );
      } else {
        this.log.info(
          `✅ All configured cities found: ${this.selectedCities.join(", ")}`
        );
      }

      return true;
    } catch (error) {
      this.log.error(`❌ Error loading cities data: ${error.message}`);
      return false;
    }
  }

  // Helper method to check if alert affects monitored cities or is nationwide
  getAffectedCities(citiesIds) {
    // Check for nationwide alert first
    if (citiesIds.includes(NATIONWIDE_CITY_ID)) {
      this.log.info("🌍 Nationwide alert detected (city ID 10000000)");
      return this.selectedCities.length > 0
        ? this.selectedCities
        : ["Nationwide"];
    }

    // Match against specific cities
    const affectedCities = this.selectedCities.filter((cityName) => {
      const cityId = this.cityNameToId.get(cityName);
      if (!cityId) {
        this.log.warn(`⚠️ City "${cityName}" not found in cities data`);
        return false;
      }
      return citiesIds.includes(cityId);
    });

    return affectedCities;
  }

  // Debounce helper method
  canTriggerAlert(alertType, cityName) {
    const key = `${alertType}_${cityName}`;
    const lastTriggered = this.alertDebounce.get(key) || 0;
    const now = Date.now();

    if (now - lastTriggered > ALERT_DEBOUNCE_TIME) {
      this.alertDebounce.set(key, now);
      this.log.debug(`✅ Debounce OK for ${alertType} in ${cityName}`);
      return true;
    }

    const minutesLeft = Math.ceil(
      (ALERT_DEBOUNCE_TIME - (now - lastTriggered)) / 60000
    );
    this.log.debug(
      `⏱️ Debounce active for ${alertType} in ${cityName} - ${minutesLeft} minutes left`
    );
    return false;
  }

  // Tzofar WebSocket setup
  setupTzofarWebSocket() {
    this.log.info(`🔌 Setting up Tzofar WebSocket connection...`);
    this.tzofarClient = new TzofarWebSocketClient(this);
    this.tzofarClient.connect();
  }

  // Primary alert handler (from Tzofar ALERT messages)
  handlePrimaryAlert(alertData) {
    this.log.debug(`🚨 Processing primary alert: ${JSON.stringify(alertData)}`);

    // Validate alert data
    if (!alertData || alertData.isDrill) {
      this.log.info("🧪 Drill alert received - ignoring");
      return;
    }

    if (!Array.isArray(alertData.cities) || alertData.cities.length === 0) {
      this.log.warn("⚠️ Primary alert missing cities data");
      return;
    }

    // Map threat ID to alert info
    const threatInfo = THREAT_ID_MAPPING[alertData.threat];
    if (!threatInfo) {
      this.log.warn(`⚠️ Unknown threat ID: ${alertData.threat}`);
      return;
    }

    // Nationwide check for primary alert: city name "רחבי הארץ"
    let affectedCities;
    if (alertData.cities.includes("רחבי הארץ")) {
      this.log.info('🌍 Nationwide primary alert detected ("רחבי הארץ")');
      affectedCities =
        this.selectedCities.length > 0 ? this.selectedCities : ["Nationwide"];
    } else {
      // Match by city name
      affectedCities = alertData.cities.filter((city) =>
        this.selectedCities.includes(city)
      );
    }

    if (affectedCities.length === 0) {
      this.log.debug(`🚨 Primary alert found but none for monitored cities`);
      return;
    }

    // Apply debounce for each affected city
    const debouncedCities = affectedCities.filter((cityName) =>
      this.canTriggerAlert(threatInfo.type, cityName)
    );

    if (debouncedCities.length === 0) {
      this.log.info(
        `🚨 Primary alert found for ${affectedCities.join(
          ", "
        )} but all are in debounce period`
      );
      return;
    }

    // Track alert type for exit notification matching
    debouncedCities.forEach((city) => {
      this.lastAlertTypePerCity.set(city, {
        alertType: alertData.threat,
        timestamp: Date.now(),
      });
    });

    // Stop any lower priority alerts
    if (this.isEarlyWarningActive) {
      this.log.info("🟡 Stopping early warning for primary alert");
      this.stopEarlyWarningPlayback();
    }
    if (this.isExitNotificationActive) {
      this.log.info("🟢 Stopping exit notification for primary alert");
      this.stopExitNotificationPlayback();
    }

    this.log.info(`PRIMARY ALERT TRIGGERED (${threatInfo.name})`);
    this.log.info(`Areas: ${debouncedCities.join(", ")}`);
    this.log.info(
      `Threat Level: ${alertData.threat} (Priority: ${threatInfo.priority})`
    );
    this.log.info(
      `Time: ${new Date().toLocaleString("en-US", {
        timeZone: "Asia/Jerusalem",
      })} (Israel time)`
    );

    // Trigger primary alert (PRIMARY ALERTS ARE NEVER TIME-RESTRICTED)
    this.isAlertActive = true;
    this.alertActiveCities = debouncedCities;
    this.service.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );

    // Ring Apple TV doorbell for PiP overlay notification
    this.ringDoorbell(ALERT_TYPES.PRIMARY, debouncedCities);

    if (this.useChromecast) {
      this.playChromecastMedia(ALERT_TYPES.PRIMARY);
    }

    // Auto-reset timer
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

  // Handle ALL system messages (early warnings + exit notifications)
  handleSystemMessage(systemMessage) {
    this.log.debug(`📋 Processing system message: ${systemMessage.titleHe}`);

    // Check if this is an early warning message
    if (this.isEarlyWarningMessage(systemMessage)) {
      this.handleEarlyWarning(systemMessage);
      return;
    }

    // Check if this is an exit notification message
    if (this.isExitNotificationMessage(systemMessage)) {
      this.handleExitNotification(systemMessage);
      return;
    }

    this.log.debug(
      "📋 System message is neither early warning nor exit notification - ignoring"
    );
  }

  // Early warning validation
  isEarlyWarningMessage(systemMessage) {
    // Check title
    const expectedTitles = ["מבזק פיקוד העורף"];
    const hasValidTitle = expectedTitles.some((title) =>
      systemMessage.titleHe?.includes(title)
    );

    if (!hasValidTitle) {
      this.log.debug(
        "📋 System message title doesn't match early warning pattern"
      );
      return false;
    }

    // Check content for early warning keywords
    const bodyHe = systemMessage.bodyHe || "";
    const hasValidContent = EARLY_WARNING_KEYWORDS.some((keyword) =>
      bodyHe.includes(keyword)
    );

    this.log.debug(
      `🔍 Early warning validation - Title: ${hasValidTitle}, Content: ${hasValidContent}`
    );
    return hasValidContent;
  }

  // Exit notification validation
  isExitNotificationMessage(systemMessage) {
    // Check title
    const expectedTitles = ["עדכון פיקוד העורף"];
    const hasValidTitle = expectedTitles.some((title) =>
      systemMessage.titleHe?.includes(title)
    );

    if (!hasValidTitle) {
      this.log.debug(
        "📋 System message title doesn't match exit notification pattern"
      );
      return false;
    }

    // Check content for exit notification keywords
    const bodyHe = systemMessage.bodyHe || "";
    const hasValidContent = EXIT_NOTIFICATION_KEYWORDS.some((keyword) =>
      bodyHe.includes(keyword)
    );

    this.log.debug(
      `🔍 Exit notification validation - Title: ${hasValidTitle}, Content: ${hasValidContent}`
    );
    return hasValidContent;
  }

  // Early warning handler (from Tzofar SYSTEM_MESSAGE)
  handleEarlyWarning(systemMessage) {
    this.log.info(`🟡 Processing early warning: ${systemMessage.titleHe}`);

    // Check if early warning alerts are enabled and within time window
    if (!this.isAlertTypeActive(ALERT_TYPES.EARLY_WARNING)) {
      this.log.info("⏸️ Early warning alerts disabled or outside time window");
      return;
    }

    // Use citiesIds for city matching
    const citiesIds = systemMessage.citiesIds || [];

    if (!Array.isArray(citiesIds) || citiesIds.length === 0) {
      this.log.warn(
        "⚠️ Early warning message missing citiesIds array - cannot match cities"
      );
      return;
    }

    // Get affected cities (including nationwide check)
    const affectedCities = this.getAffectedCities(citiesIds);

    if (affectedCities.length === 0) {
      this.log.info(`🟡 Early warning found but none for monitored cities`);
      return;
    }

    // Apply debounce
    const debouncedCities = affectedCities.filter((cityName) =>
      this.canTriggerAlert(ALERT_TYPES.EARLY_WARNING, cityName)
    );

    if (debouncedCities.length === 0) {
      this.log.info(
        `🟡 Early warning found for ${affectedCities.join(
          ", "
        )} but all are in debounce period`
      );
      return;
    }

    // Check if primary alert is active
    if (this.isAlertActive) {
      this.log.info(
        `🟡 Early warning found but skipped (primary alert active)`
      );
      return;
    }

    // Stop any existing early warning
    if (this.isEarlyWarningActive) {
      this.log.info("🟡 New early warning interrupting existing early warning");
      this.stopEarlyWarningPlayback();
    }

    this.log.info(
      `🟡 EARLY WARNING TRIGGERED for areas: ${debouncedCities.join(", ")}`
    );

    // Ring Apple TV doorbell for PiP overlay notification
    this.ringDoorbell(ALERT_TYPES.EARLY_WARNING, debouncedCities);

    this.triggerEarlyWarning(debouncedCities);
  }

  // Exit notification handler (from Tzofar SYSTEM_MESSAGE)
  handleExitNotification(systemMessage) {
    this.log.info(`🟢 Processing exit notification: ${systemMessage.titleHe}`);

    // Check if exit notifications are enabled and within time window
    if (!this.isAlertTypeActive(ALERT_TYPES.EXIT_NOTIFICATION)) {
      this.log.info("⏸️ Exit notifications disabled or outside time window");
      return;
    }

    // Use citiesIds for city matching
    const citiesIds = systemMessage.citiesIds || [];

    if (!Array.isArray(citiesIds) || citiesIds.length === 0) {
      this.log.warn(
        "⚠️ Exit notification message missing citiesIds array - cannot match cities"
      );
      return;
    }

    // Get affected cities (including nationwide check)
    const affectedCities = this.getAffectedCities(citiesIds);

    if (affectedCities.length === 0) {
      this.log.info(`🟢 Exit notification found but none for monitored cities`);
      return;
    }

    // Apply debounce
    const debouncedCities = affectedCities.filter((cityName) =>
      this.canTriggerAlert(ALERT_TYPES.EXIT_NOTIFICATION, cityName)
    );

    if (debouncedCities.length === 0) {
      this.log.info(
        `🟢 Exit notification found for ${affectedCities.join(
          ", "
        )} but all are in debounce period`
      );
      return;
    }

    // Primary alerts take priority over exit notifications
    if (this.isAlertActive) {
      this.log.info(
        `🟢 Exit notification found but skipped (primary alert active)`
      );
      return;
    }

    this.log.info(
      `🟢 EXIT NOTIFICATION TRIGGERED for areas: ${debouncedCities.join(", ")}`
    );

    // Ring Apple TV doorbell for PiP overlay notification
    this.ringDoorbell(ALERT_TYPES.EXIT_NOTIFICATION, debouncedCities);

    this.triggerExitNotification(debouncedCities);
  }

  /**
   * Merge user config for alerts with plugin defaults.
   */
  parseAlertsConfig(config) {
    const alerts = config.alerts || {};
    const result = {};
    for (const type of [
      ALERT_TYPES.EARLY_WARNING,
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
      .setCharacteristic(Characteristic.Model, "Red Alert Tzofar")
      .setCharacteristic(Characteristic.SerialNumber, "4.1.0");

    this.service
      .getCharacteristic(Characteristic.ContactSensorState)
      .on("get", this.getAlertState.bind(this));
    this.earlyWarningService
      .getCharacteristic(Characteristic.ContactSensorState)
      .on("get", this.getEarlyWarningState.bind(this));
    this.exitNotificationService
      .getCharacteristic(Characteristic.ContactSensorState)
      .on("get", this.getExitNotificationState.bind(this));

    const services = [
      informationService,
      this.service,
      this.testSwitchService,
      this.earlyWarningService,
      this.exitNotificationService,
    ];

    return services;
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

  // --- Apple TV Doorbell Methods ---

  /**
   * Ring the doorbell to trigger Apple TV PiP notification
   * Throttled to prevent excessive ringing
   */
  ringDoorbell(alertType, cities) {
    if (!this.useAppleTVDoorbell) {
      return;
    }

    const now = Date.now();
    if (now - this.lastDoorbellRing < this.doorbellThrottle) {
      this.log.debug(
        `Doorbell ring throttled (${Math.ceil(
          (this.doorbellThrottle - (now - this.lastDoorbellRing)) / 1000
        )}s remaining)`
      );
      return;
    }

    this.lastDoorbellRing = now;
    this.log.info(
      `Ringing Apple TV doorbell for ${alertType}: ${cities.join(", ")}`
    );

    // Trigger the camera platform doorbell if available
    if (cameraPlatformInstance) {
      cameraPlatformInstance.ringDoorbell(alertType);
    } else {
      this.log.warn("Camera platform not available - add RedAlertCamera platform to config");
    }
  }

  triggerTest() {
    this.log.info(`TEST ALERT TRIGGERED`);
    this.isAlertActive = true;
    this.alertActiveCities =
      this.selectedCities.length > 0 ? [this.selectedCities[0]] : ["Test"];
    this.service.updateCharacteristic(
      Characteristic.ContactSensorState,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );

    // Ring Apple TV doorbell for PiP overlay notification
    this.ringDoorbell(ALERT_TYPES.PRIMARY, this.alertActiveCities);

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
    this.log.debug("🧹 Setting up cleanup timer (hourly)");
    setInterval(() => {
      const cutoff = Date.now() - 2 * 60 * 60 * 1000;

      // Clean up debounce entries older than 2 hours
      let debounceCleaned = 0;
      for (const [key, timestamp] of this.alertDebounce) {
        if (timestamp < cutoff) {
          this.alertDebounce.delete(key);
          debounceCleaned++;
        }
      }
      if (debounceCleaned) {
        this.log.debug(`🧹 Cleaned up ${debounceCleaned} debounce entries`);
      }

      // Clean up last alert type tracking older than 24 hours
      const alertCutoff = Date.now() - 24 * 60 * 60 * 1000;
      let alertTypeCleaned = 0;
      for (const [city, alertInfo] of this.lastAlertTypePerCity) {
        if (alertInfo.timestamp < alertCutoff) {
          this.lastAlertTypePerCity.delete(city);
          alertTypeCleaned++;
        }
      }
      if (alertTypeCleaned) {
        this.log.debug(
          `🧹 Cleaned up ${alertTypeCleaned} alert type tracking entries`
        );
      }
    }, 3600000);
  }

  /**
   * Return true if alert type is enabled and within time window.
   * PRIMARY ALERTS ARE NEVER TIME-RESTRICTED.
   */
  isAlertTypeActive(type) {
    const cfg = this.alertsConfig[type];
    if (!cfg || !cfg.enabled) {
      this.log.debug(`⏸️ Alert type ${type} is disabled`);
      return false;
    }

    // Primary alerts are never time-restricted
    if (type === ALERT_TYPES.PRIMARY) {
      return true;
    }

    // Check time restrictions if configured
    if (typeof cfg.startHour === "number" && typeof cfg.endHour === "number") {
      const now = new Date();
      const israelTime = new Date(
        now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" })
      );
      const currentHour = israelTime.getHours();

      // Handle overnight ranges (e.g., 22-6)
      let isInTimeWindow;
      if (cfg.startHour <= cfg.endHour) {
        // Same day range (e.g., 8-22)
        isInTimeWindow =
          currentHour >= cfg.startHour && currentHour <= cfg.endHour;
      } else {
        // Overnight range (e.g., 22-6)
        isInTimeWindow =
          currentHour >= cfg.startHour || currentHour <= cfg.endHour;
      }

      if (!isInTimeWindow) {
        this.log.info(
          `⏰ Alert type ${type} outside time window (${cfg.startHour}-${cfg.endHour}), current hour: ${currentHour} (Israel time)`
        );
        return false;
      }

      this.log.debug(
        `⏰ Alert type ${type} within time window (${cfg.startHour}-${cfg.endHour}), current hour: ${currentHour} (Israel time)`
      );
    }

    return true;
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
      this.playChromecastMedia(ALERT_TYPES.EARLY_WARNING);
    }

    // Auto-reset timer
    setTimeout(() => this.resetEarlyWarning(), this.chromecastTimeout * 1000);
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
      this.playChromecastMedia(ALERT_TYPES.EXIT_NOTIFICATION);
    }

    // Auto-reset timer
    setTimeout(
      () => this.resetExitNotification(),
      this.chromecastTimeout * 1000
    );
  }

  stopEarlyWarningPlayback() {
    this.log.info("🛑 Stopping early warning playback");
    this.resetEarlyWarning();
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
   * More reliable Chromecast playback implementation based on the older version
   */
  playChromecastMedia(alertType) {
    try {
      this.log.info(`🎵 Playing ${alertType} on Chromecast devices`);

      if (!this.devices.length) {
        this.log.warn("❌ No Chromecast devices available");
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
        this.log.warn(
          "❌ No valid Chromecast devices available after filtering"
        );
        return;
      }

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
          this.log.info(`🏠 Shelter device identified: ${device.friendlyName}`);
        } else {
          regularDevices.push(device);
          this.log.info(`📺 Regular device identified: ${device.friendlyName}`);
        }
      });

      // Process shelter devices
      shelterDevices.forEach(({ device, config }) => {
        let mediaUrl,
          volume,
          shouldPlay = true;

        // Check cooldown for early warnings only
        if (alertType === ALERT_TYPES.EARLY_WARNING) {
          if (
            !this.canPlayShelterInstructions(device.friendlyName, alertType)
          ) {
            this.log.info(
              `🏠 Skipping ${alertType} on ${device.friendlyName} - cooldown active (${this.shelterInstructions.minIntervalMinutes} min)`
            );
            shouldPlay = false;
            return;
          } else {
            this.markShelterInstructionsPlayed(device.friendlyName, alertType);
            this.log.info(
              `🏠 Cooldown OK for ${alertType} on ${device.friendlyName}`
            );
          }
        }

        if (shouldPlay) {
          switch (alertType) {
            case ALERT_TYPES.PRIMARY:
              mediaUrl = `${this.baseUrl}/shelter-instructions-primary`;
              volume = config.volumes?.primary || 50;
              this.markShelterInstructionsPlayed(
                device.friendlyName,
                "primary"
              );
              break;
            case ALERT_TYPES.EARLY_WARNING:
              mediaUrl = `${this.baseUrl}/shelter-instructions-early-warning`;
              volume = config.volumes?.["early-warning"] || 60;
              break;
            case ALERT_TYPES.EXIT_NOTIFICATION:
              mediaUrl = `${this.baseUrl}/shelter-instructions-exit-notification`;
              volume = config.volumes?.["exit-notification"] || 60;
              this.markShelterInstructionsPlayed(
                device.friendlyName,
                "exit-notification"
              );
              break;
            case ALERT_TYPES.TEST:
              mediaUrl = `${this.baseUrl}/test-video`;
              volume = config.volumes?.primary || 50;
              break;
            default:
              this.log.error(
                `❌ Unknown alert type for shelter device: ${alertType}`
              );
              return;
          }

          this.log.info(
            `🏠 Playing ${alertType} on ${device.friendlyName} at ${volume}% volume`
          );
          this.playWithRetry(device, mediaUrl, 3, volume);
        }
      });

      // Process regular devices
      if (regularDevices.length > 0) {
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
          case ALERT_TYPES.EXIT_NOTIFICATION:
            mediaUrl = `${this.baseUrl}/exit-notification-video`;
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
            `📺 Playing ${alertType} on ${device.friendlyName} at ${volume}% volume`
          );
          this.playWithRetry(device, mediaUrl, 3, volume);
        });
      }
    } catch (error) {
      this.log.error(`Error playing Chromecast media: ${error.message}`);
    }
  }

  /**
   * Simple but reliable retry mechanism for Chromecast playback
   */
  playWithRetry(device, mediaUrl, retries, volume) {
    try {
      this.log.debug(`📺 Attempting playback on ${device.friendlyName}`);

      device.play(mediaUrl, (err) => {
        if (err && retries > 0) {
          this.log.warn(
            `⚠️ Retrying playback on ${device.friendlyName} (${retries} left): ${err.message}`
          );
          setTimeout(
            () => this.playWithRetry(device, mediaUrl, retries - 1, volume),
            2000
          );
        } else if (err) {
          this.log.error(
            `❌ Failed to play on ${device.friendlyName}: ${err.message}`
          );
        } else {
          this.log.info(
            `▶️ Successfully started playback on ${device.friendlyName}`
          );

          // Set volume immediately after successful play
          device.setVolume(volume / 100, (volErr) => {
            if (volErr) {
              this.log.warn(
                `⚠️ Failed to set volume on ${device.friendlyName}: ${volErr.message}`
              );
            } else {
              this.log.debug(
                `🔊 Volume set to ${volume}% on ${device.friendlyName}`
              );
            }
          });
        }
      });
    } catch (error) {
      this.log.error(
        `❌ Synchronous error playing on ${device.friendlyName}: ${error.message}`
      );
      if (retries > 0) {
        setTimeout(
          () => this.playWithRetry(device, mediaUrl, retries - 1, volume),
          2000
        );
      }
    }
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
        `🏠 Cooldown check for ${deviceName}/${alertType}: ${minutesLeft} minutes remaining`
      );
    }

    return canPlay;
  }

  markShelterInstructionsPlayed(deviceName, alertType) {
    if (!this.shelterInstructionsLastPlayed[deviceName])
      this.shelterInstructionsLastPlayed[deviceName] = {};
    this.shelterInstructionsLastPlayed[deviceName][alertType] = Date.now();
    this.log.debug(
      `🏠 Marked ${alertType} as played on ${deviceName} at ${new Date().toISOString()}`
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

    let volume = this.chromecastVolume;
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

  /**
   * Optimized media server with caching and compression
   */
  setupMediaServer() {
    try {
      this.log.info(`🌐 Setting up media server on port ${this.serverPort}...`);
      this.server = express();

      // Add compression for faster media delivery
      this.server.use(compression());

      const mediaDir = path.join(
        this.api.user.storagePath(),
        "red-alert-media"
      );
      fs.ensureDirSync(mediaDir);

      // Set caching headers for better performance
      this.server.use((req, res, next) => {
        // Cache for 1 hour
        res.setHeader("Cache-Control", "public, max-age=3600");
        next();
      });

      this.server.use(
        express.static(mediaDir, {
          etag: true,
          lastModified: true,
        })
      );

      // Media endpoints with file existence checking
      const createMediaEndpoint = (route, filePath, name) => {
        this.server.get(route, (req, res) => {
          const fullPath = path.join(mediaDir, filePath);
          if (fs.existsSync(fullPath)) {
            res.sendFile(fullPath);
          } else {
            this.log.warn(`⚠️ Media file not found: ${filePath}`);
            res.status(404).send(`Media file ${name} not found`);
          }
        });
      };

      createMediaEndpoint("/alert-video", this.alertVideoPath, "alert video");
      createMediaEndpoint("/test-video", this.testVideoPath, "test video");
      createMediaEndpoint(
        "/early-warning-video",
        this.earlyWarningVideoPath,
        "early warning video"
      );
      createMediaEndpoint(
        "/exit-notification-video",
        this.exitNotificationVideoPath,
        "exit notification video"
      );

      // Shelter instructions endpoints
      createMediaEndpoint(
        "/shelter-instructions-primary",
        this.shelterInstructions.primaryFile ||
          this.ballisticClosureFile ||
          "ballistic_closure.mp4",
        "primary shelter instructions"
      );
      createMediaEndpoint(
        "/shelter-instructions-early-warning",
        this.shelterInstructions.earlyWarningFile ||
          this.windowsClosedFile ||
          "ballistic_windows_closed.mp4",
        "early warning shelter instructions"
      );
      createMediaEndpoint(
        "/shelter-instructions-exit-notification",
        this.shelterInstructions.exitFile || this.shelterExitFile || "exit.mp4",
        "exit notification shelter instructions"
      );

      this.server.get("/health", (req, res) => {
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

  // Cleanup method
  cleanup() {
    this.log.info("🧹 Cleaning up Red Alert plugin...");

    if (this.tzofarClient) {
      this.tzofarClient.disconnect();
    }

    // Close media server
    if (this.server && typeof this.server.close === "function") {
      this.server.close();
    }

    // Clean up Chromecast client
    if (
      this.chromecastClient &&
      typeof this.chromecastClient.destroy === "function"
    ) {
      this.chromecastClient.destroy();
    }

    this.devices = [];
  }
}

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  // Register platform - this creates both the camera AND the sensors
  api.registerPlatform("homebridge-red-alert", "RedAlertCamera", RedAlertCameraPlatform);

  // Keep accessory registration for backward compatibility with old configs
  api.registerAccessory("homebridge-red-alert", "RedAlert", RedAlertPlugin);
};

/**
 * RedAlertHandler - Alert handling logic for use with platform accessories
 * This is used by RedAlertCameraPlatform to create sensors on a platform accessory
 */
class RedAlertHandler extends RedAlertPlugin {
  constructor(log, config, api, platformAccessory, cameraPlatform) {
    // Call parent constructor but we'll override service creation
    super(log, config, api);

    this.platformAccessory = platformAccessory;
    this.cameraPlatform = cameraPlatform;

    // Remove services created by parent and recreate on platform accessory
    this.setupPlatformServices();
  }

  setupPlatformServices() {
    // Get or add services on the platform accessory
    this.service = this.platformAccessory.getService(Service.ContactSensor) ||
      this.platformAccessory.addService(Service.ContactSensor, this.name, "primary");

    this.testSwitchService = this.platformAccessory.getService(Service.Switch) ||
      this.platformAccessory.addService(Service.Switch, `${this.name} Test`, "test");

    this.earlyWarningService = this.platformAccessory.getServiceById(Service.ContactSensor, "early-warning") ||
      this.platformAccessory.addService(Service.ContactSensor, `${this.name} Early Warning`, "early-warning");

    this.exitNotificationService = this.platformAccessory.getServiceById(Service.ContactSensor, "exit-notification") ||
      this.platformAccessory.addService(Service.ContactSensor, `${this.name} Exit Notification`, "exit-notification");

    // Setup characteristics
    this.testSwitchService
      .getCharacteristic(Characteristic.On)
      .on("set", this.handleTestSwitch.bind(this));

    this.service
      .getCharacteristic(Characteristic.ContactSensorState)
      .on("get", this.getAlertState.bind(this));

    this.earlyWarningService
      .getCharacteristic(Characteristic.ContactSensorState)
      .on("get", this.getEarlyWarningState.bind(this));

    this.exitNotificationService
      .getCharacteristic(Characteristic.ContactSensorState)
      .on("get", this.getExitNotificationState.bind(this));

    this.log.info("Platform services configured: Contact sensors + Test switch");
  }

  // Override getServices since we don't need it for platform accessories
  getServices() {
    return [];
  }
}

/**
 * Camera Platform for Apple TV Doorbell notifications
 * Creates a separate camera accessory that shows PiP on Apple TV
 */
class RedAlertCameraPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    this.cachedAccessories = new Map();

    this.name = this.config.name || "Red Alert Camera";
    this.videoProcessor = this.config.videoProcessor || "ffmpeg";
    this.mediaPath = this.config.mediaPath || path.join(__dirname, "media");

    // Alert state
    this.currentState = "idle"; // idle, pre-alert, alert

    // Store global reference so accessory can trigger doorbell
    cameraPlatformInstance = this;

    // Create internal alert handler (RedAlertPlugin instance without accessory registration)
    // This handles all the alert logic, WebSocket, Chromecast, etc.
    this.alertHandler = null;

    if (api) {
      api.on("didFinishLaunching", () => {
        this.log.info("Red Alert Camera Platform loaded");
        this.setupCamera();
        this.setupSensorsAccessory();
      });
    }
  }

  setupSensorsAccessory() {
    // Create or restore the sensors accessory
    const sensorName = this.config.name || "Red Alert";
    const uuid = UUIDGen.generate(sensorName + "-sensors");

    let sensorsAccessory = this.cachedAccessories.get(uuid);

    if (!sensorsAccessory) {
      this.log.info("Creating new sensors accessory: " + sensorName);
      sensorsAccessory = new this.api.platformAccessory(sensorName, uuid);

      // Add accessory info
      sensorsAccessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, "Homebridge")
        .setCharacteristic(Characteristic.Model, "Red Alert Tzofar")
        .setCharacteristic(Characteristic.SerialNumber, "RA-SENSORS-001");

      this.api.registerPlatformAccessories("homebridge-red-alert", "RedAlertCamera", [sensorsAccessory]);
    }

    // Create the internal alert handler with the sensors accessory
    this.alertHandler = new RedAlertHandler(this.log, this.config, this.api, sensorsAccessory, this);

    this.log.info("Red Alert sensors accessory configured");
  }

  setupCamera() {
    const uuid = UUIDGen.generate(this.name);
    const accessory = new this.api.platformAccessory(this.name, uuid, this.api.hap.Categories.VIDEO_DOORBELL);

    // Add accessory info
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Red Alert")
      .setCharacteristic(Characteristic.Model, "Siren Doorbell")
      .setCharacteristic(Characteristic.SerialNumber, "RA-CAM-001");

    // Create doorbell service
    const doorbellService = new Service.Doorbell(this.name);
    accessory.addService(doorbellService);

    // Create camera controller
    const delegate = new RedAlertStreamingDelegate(this.api.hap, this.config, this.log, this);

    const options = {
      cameraStreamCount: 2,
      delegate: delegate,
      streamingOptions: {
        supportedCryptoSuites: [this.api.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [1920, 1080, 30],
            [1280, 720, 30],
            [640, 480, 30],
            [640, 360, 30],
            [320, 240, 15],
          ],
          codec: {
            profiles: [this.api.hap.H264Profile.BASELINE],
            levels: [this.api.hap.H264Level.LEVEL3_1],
          },
        },
        audio: undefined, // No audio for simplicity
      },
    };

    const cameraController = new this.api.hap.CameraController(options);
    accessory.configureController(cameraController);

    this.cameraController = cameraController;
    this.doorbellService = doorbellService;
    this.delegate = delegate;

    // Publish as external accessory
    this.api.publishExternalAccessories("homebridge-red-alert", [accessory]);
    this.log.info("Red Alert Camera published - add it in Home app using code from Homebridge");
  }

  // Called by main plugin to ring doorbell
  ringDoorbell(alertType) {
    if (!this.doorbellService) return;

    // Update camera state based on alert type
    let cameraState = "alert";
    if (alertType === "early-warning") {
      cameraState = "pre-alert";
    } else if (alertType === "exit-notification") {
      cameraState = "exit";
    } else if (alertType === "drone") {
      cameraState = "drone";
    } else {
      cameraState = "alert"; // primary, test, etc.
    }

    this.currentState = cameraState;
    if (this.delegate) this.delegate.setCurrentState(cameraState);

    this.log.info(`Ringing doorbell for ${alertType}, camera state: ${this.currentState}`);

    // Small delay to ensure snapshot reflects new state before doorbell rings
    setTimeout(() => {
      // Trigger doorbell
      this.doorbellService
        .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
        .updateValue(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    }, 300);

    // Reset to idle after 15 seconds (shortly after test alerts reset)
    setTimeout(() => {
      this.currentState = "idle";
      if (this.delegate) this.delegate.setCurrentState("idle");
      this.log.debug("Camera state reset to idle");
    }, 15000);
  }

  configureAccessory(accessory) {
    this.log.info("Restoring cached accessory: " + accessory.displayName);
    this.cachedAccessories.set(accessory.UUID, accessory);
    this.accessories.push(accessory);
  }
}

/**
 * Streaming delegate for camera
 */
class RedAlertStreamingDelegate {
  constructor(hap, config, log, platform) {
    this.hap = hap;
    this.log = log;
    this.platform = platform;
    this.videoProcessor = config.videoProcessor || "ffmpeg";
    this.mediaPath = config.mediaPath || path.join(__dirname, "media");

    this.currentState = "idle";
    this.pendingSessions = new Map();
    this.ongoingSessions = new Map();
  }

  setCurrentState(state) {
    this.currentState = state;
  }

  getCurrentImage() {
    switch (this.currentState) {
      case "alert":
        return path.join(this.mediaPath, "alert-still.png");
      case "pre-alert":
        return path.join(this.mediaPath, "early-alert.png");
      case "drone":
        return path.join(this.mediaPath, "alert-still.png");
      case "exit":
        return path.join(this.mediaPath, "exit.png");
      default:
        return path.join(this.mediaPath, "alert-still.png");
    }
  }

  handleSnapshotRequest(request, callback) {
    const currentImage = this.getCurrentImage();
    this.log.info(`Snapshot requested: ${request.width}x${request.height}, state: ${this.currentState}, image: ${currentImage}`);

    // Check if image exists
    if (!fs.existsSync(currentImage)) {
      this.log.error(`Snapshot image not found: ${currentImage}`);
      callback(new Error("Image not found"));
      return;
    }

    // Read image directly without ffmpeg - much faster on slow devices like Pi Zero
    // HomeKit can handle PNG images and will resize as needed
    try {
      const imageBuffer = fs.readFileSync(currentImage);
      this.log.info(`Snapshot read successfully: ${imageBuffer.length} bytes`);
      callback(undefined, imageBuffer);
    } catch (error) {
      this.log.error(`Failed to read snapshot image: ${error.message}`);
      callback(error);
    }
  }

  prepareStream(request, callback) {
    const sessionInfo = {
      address: request.targetAddress,
      videoPort: request.video.port,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC: this.hap.CameraController.generateSynchronisationSource(),
    };

    this.pendingSessions.set(request.sessionID, sessionInfo);

    callback(undefined, {
      video: {
        port: request.video.port,
        ssrc: sessionInfo.videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
    });
  }

  handleStreamRequest(request, callback) {
    const sessionId = request.sessionID;

    if (request.type === this.hap.StreamRequestTypes.START) {
      const session = this.pendingSessions.get(sessionId);
      if (!session) {
        callback(new Error("No session"));
        return;
      }

      const currentImage = this.getCurrentImage();
      const ffmpegArgs = [
        "-loop", "1",
        "-i", currentImage,
        "-vf", `scale=${request.video.width}:${request.video.height}`,
        "-vcodec", "libx264",
        "-pix_fmt", "yuv420p",
        "-r", String(Math.min(request.video.fps, 15)),
        "-tune", "stillimage",
        "-preset", "ultrafast",
        "-b:v", `${request.video.max_bit_rate}k`,
        "-payload_type", String(request.video.pt),
        "-ssrc", session.videoSSRC.toString(),
        "-f", "rtp",
        "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
        "-srtp_out_params", session.videoSRTP.toString("base64"),
        `srtp://${session.address}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=1316`,
      ];

      const ffmpeg = spawn(this.videoProcessor, ffmpegArgs, { env: process.env });
      ffmpeg.on("close", () => this.ongoingSessions.delete(sessionId));
      this.ongoingSessions.set(sessionId, ffmpeg);
      this.pendingSessions.delete(sessionId);
      callback();

    } else if (request.type === this.hap.StreamRequestTypes.STOP) {
      const ffmpeg = this.ongoingSessions.get(sessionId);
      if (ffmpeg) {
        ffmpeg.kill("SIGKILL");
        this.ongoingSessions.delete(sessionId);
      }
      callback();
    } else {
      callback();
    }
  }
};
