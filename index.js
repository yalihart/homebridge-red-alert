/**
 * Homebridge Red Alert Plugin with Tzofar WebSocket Integration
 * Monitors Israeli Home Front Command alerts via Tzofar WebSocket and provides HomeKit/Chromecast notifications
 *
 * Features:
 * - Tzofar WebSocket for real-time primary alerts and early warnings
 * - OREF polling for flash alerts and exit notifications
 * - Per-alert-type enable/time/volume controls with time restrictions
 * - Per-device, per-alert-type volume
 * - City filtering with ID-based matching for early warnings
 * - 2-minute debounce for duplicate alerts
 * - Enhanced early warning validation with Hebrew keywords
 * - Shelter instruction devices with cooldown periods
 * - Event-based Chromecast completion tracking
 *
 * Author: Yali Hart & AI Friends
 * License: MIT
 */

const WebSocket = require("ws");
const fs = require("fs-extra");
const path = require("path");
const express = require("express");
const ChromecastAPI = require("chromecast-api");
const https = require("https");
const os = require("os");
const crypto = require("crypto");

let Service, Characteristic;

// Alert types and their canonical titles (in Hebrew)
const ALERT_TYPES = {
  PRIMARY: "primary",
  TEST: "test",
  EARLY_WARNING: "early-warning",
  FLASH_SHELTER: "flash-shelter",
  EXIT_NOTIFICATION: "exit-notification",
};

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

// Exit notification titles
const EXIT_NOTIFICATION_TITLES = {
  TERRORIST: "חדירת כלי טיס עוין - האירוע הסתיים",
  MISSILE: "ירי רקטות וטילים -  האירוע הסתיים",
};

// Flash alert titles
const FLASH_ALERT_TITLES = [
  "שהייה בסמיכות למרחב מוגן",
  "בדקות הקרובות צפויות להתקבל התרעות באזורך",
  "היכנסו למרחב המוגן ושהו בו 10 דקות",
];

const DEFAULT_ALERTS_CONFIG = {
  [ALERT_TYPES.EARLY_WARNING]: {
    enabled: true,
    volume: 60,
  },
  [ALERT_TYPES.FLASH_SHELTER]: {
    enabled: true,
    volume: 50,
  },
  [ALERT_TYPES.EXIT_NOTIFICATION]: {
    enabled: true,
    volume: 45,
  },
};

const DEFAULT_MEDIA_PATHS = {
  alertVideoPath: "alert.mp4",
  earlyWarningVideoPath: "early.mp4",
  flashAlertShelterVideoPath: "flash-shelter.mp4",
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
        this.plugin.log.info(
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

      // Use .info instead of .debug so we can see all messages
      this.plugin.log.info(`📡 Received Tzofar message type: ${data.type}`);

      if (data.type === "ALERT") {
        this.plugin.log.info(
          `🚨 Processing ALERT: ${JSON.stringify(data.data)}`
        );
        this.plugin.handlePrimaryAlert(data.data);
      } else if (data.type === "SYSTEM_MESSAGE") {
        this.plugin.log.info(
          `🟡 Processing SYSTEM_MESSAGE: ${JSON.stringify(data.data)}`
        );
        this.plugin.handleEarlyWarning(data.data);
      } else {
        this.plugin.log.info(
          `📋 Unknown Tzofar message type: ${
            data.type
          } - Full data: ${JSON.stringify(data)}`
        );
      }
    } catch (error) {
      this.plugin.log.warn(
        `❌ Invalid JSON in Tzofar message: ${error.message}`
      );
      this.plugin.log.warn(`❌ Raw message: ${message}`);
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
        Math.pow(2, this.reconnectAttempts),
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

    // --- OREF polling configuration
    this.orefPollInterval = config.orefPollInterval || 3000;
    this.orefUrl =
      config.orefUrl ||
      "https://www.oref.org.il/warningMessages/alert/Alerts.json";

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

    // --- State for HomeKit
    this.isAlertActive = false;
    this.isEarlyWarningActive = false;
    this.isFlashAlertActive = false;
    this.isExitNotificationActive = false;
    this.alertActiveCities = [];
    this.earlyWarningActiveCities = [];
    this.flashAlertActiveCities = [];
    this.exitNotificationActiveCities = [];
    this.tzofarClient = null;
    this.orefTimer = null;
    this.devices = [];

    // Deduplication sets
    this.processedExitNotifications = new Set();
    this.processedFlashAlerts = new Set();

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
        this.setupOrefAlertsMonitoring();
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

    // Check if any of our configured cities are affected
    const affectedCities = alertData.cities.filter((city) =>
      this.selectedCities.includes(city)
    );

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
    if (this.isFlashAlertActive) {
      this.log.info("🔴 Stopping flash alert for primary alert");
      this.stopFlashAlertPlayback();
    }
    if (this.isExitNotificationActive) {
      this.log.info("🟢 Stopping exit notification for primary alert");
      this.stopExitNotificationPlayback();
    }

    this.log.info(`🚨 PRIMARY ALERT TRIGGERED (${threatInfo.name})`);
    this.log.info(`📍 Areas: ${debouncedCities.join(", ")}`);
    this.log.info(
      `⚠️ Threat Level: ${alertData.threat} (Priority: ${threatInfo.priority})`
    );
    this.log.info(
      `⏰ Time: ${new Date().toLocaleString("en-US", {
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

    if (this.useChromecast) {
      this.playChromecastMedia(ALERT_TYPES.PRIMARY, () => {
        this.log.info(`✅ Primary alert playback completed, resetting state`);
        this.isAlertActive = false;
        this.alertActiveCities = [];
        this.service.updateCharacteristic(
          Characteristic.ContactSensorState,
          Characteristic.ContactSensorState.CONTACT_DETECTED
        );
      });
    } else {
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

  // Early warning validation
  isEarlyWarningMessage(systemMessage) {
    // Check title
    const expectedTitles = ["מבזק פיקוד העורף"];
    const hasValidTitle = expectedTitles.some((title) =>
      systemMessage.titleHe?.includes(title)
    );

    if (!hasValidTitle) {
      this.log.info(
        "📋 System message title doesn't match early warning pattern"
      );
      return false;
    }

    // Check content for early warning keywords
    const bodyHe = systemMessage.bodyHe || "";
    const hasValidContent = EARLY_WARNING_KEYWORDS.some((keyword) =>
      bodyHe.includes(keyword)
    );

    this.log.info(
      `🔍 Early warning validation - Title: ${hasValidTitle}, Content: ${hasValidContent}`
    );
    return hasValidContent;
  }

  // Early warning handler (from Tzofar SYSTEM_MESSAGE)
  handleEarlyWarning(systemMessage) {
    this.log.info(`🟡 Processing system message: ${systemMessage.titleHe}`);
    this.log.info(`🟡 Full system message: ${JSON.stringify(systemMessage)}`);

    // Check if this is actually an early warning message
    if (!this.isEarlyWarningMessage(systemMessage)) {
      this.log.info("📋 System message is not an early warning - ignoring");
      return;
    }

    // Check if early warning alerts are enabled and within time window
    if (!this.isAlertTypeActive(ALERT_TYPES.EARLY_WARNING)) {
      this.log.info("⏸️ Early warning alerts disabled or outside time window");
      return;
    }

    // Use citiesIds ONLY for city matching, log both for debugging
    const citiesIds = systemMessage.citiesIds || [];
    const areasIds = systemMessage.areasIds || [];

    if (!Array.isArray(citiesIds) || citiesIds.length === 0) {
      this.log.warn(
        "⚠️ Early warning message missing citiesIds array - cannot match cities"
      );
      return;
    }

    // Match against citiesIds ONLY (not areasIds)
    const affectedCities = this.selectedCities.filter((cityName) => {
      const cityId = this.cityNameToId.get(cityName);
      this.log.info(
        `🟡 Checking city "${cityName}" (ID: ${cityId}) against cities: ${JSON.stringify(
          citiesIds
        )}`
      );

      if (!cityId) {
        this.log.warn(`⚠️ City "${cityName}" not found in cities data`);
        return false;
      }

      const isAffected = citiesIds.includes(cityId);
      this.log.info(`🟡 City "${cityName}" affected: ${isAffected}`);
      return isAffected;
    });

    this.log.info(
      `🟡 Affected cities after filtering: ${JSON.stringify(affectedCities)}`
    );

    if (affectedCities.length === 0) {
      this.log.info(
        `🟡 Early warning found but none for monitored cities (${this.selectedCities.join(
          ", "
        )})`
      );
      return;
    }

    // Apply debounce - check if we can trigger alerts for these cities
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
    this.triggerEarlyWarning(debouncedCities);
  }

  // OREF alerts monitoring (flash alerts and exit notifications)
  setupOrefAlertsMonitoring() {
    this.log.info(
      `🚪🔴 Setting up OREF alerts monitoring (${this.orefPollInterval}ms interval)`
    );

    this.pollOrefAlerts();
    this.orefTimer = setInterval(
      () => this.pollOrefAlerts(),
      this.orefPollInterval
    );
  }

  pollOrefAlerts() {
    this.log.debug("🚪🔴 Polling OREF API for all alert types...");

    const options = {
      headers: {
        "sec-ch-ua-platform": '"Android"',
        Referer: "https://www.oref.org.il/eng/contact-page",
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36",
        Accept: "application/json, text/plain, */*",
        "sec-ch-ua":
          '"Brave";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
        "sec-ch-ua-mobile": "?1",
      },
    };

    const req = https.get(this.orefUrl, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          this.log.warn(`⚠️ OREF API returned status: ${res.statusCode}`);
          return;
        }

        try {
          const cleanedData = data.startsWith("\ufeff")
            ? data.substring(1)
            : data;
          if (cleanedData.trim() === "") {
            this.log.debug("🚪🔴 No active OREF alerts");
            return;
          }

          const parsedData = JSON.parse(cleanedData);
          const alertsArray = Array.isArray(parsedData)
            ? parsedData
            : [parsedData];

          this.log.info(`🚪🔴 OREF API returned ${alertsArray.length} alerts`);

          // Log all categories to see what we're getting
          const categories = [...new Set(alertsArray.map((a) => a.cat))];
          this.log.info(`📋 OREF categories found: ${categories.join(", ")}`);

          // Process different alert types
          this.processOrefAlerts(alertsArray);
        } catch (err) {
          this.log.error(`❌ Error parsing OREF alert data: ${err.message}`);
        }
      });
    });

    req.on("error", (error) =>
      this.log.error(`❌ OREF polling request error: ${error.message}`)
    );

    req.setTimeout(10000, () => {
      req.destroy();
      this.log.warn("⚠️ OREF polling request timeout");
    });
  }

  processOrefAlerts(alerts) {
    const now = Date.now();
    const cutoffTime = now - 60000;

    alerts.forEach((alert) => {
      // Log each alert for debugging
      this.log.debug(
        `📋 OREF Alert - Cat: ${alert.cat}, Title: "${
          alert.title
        }", Data: ${JSON.stringify(alert.data)}`
      );

      // Process based on category
      if (alert.cat === "10") {
        // Exit notifications
        this.processExitNotification(alert, now, cutoffTime);
      } else if (alert.cat === "14") {
        // Flash alerts
        this.processFlashAlert(alert, now, cutoffTime);
      } else {
        // Log unknown categories
        this.log.debug(
          `❓ Unknown OREF category ${alert.cat}: "${alert.title}"`
        );
      }
    });
  }

  processExitNotification(notification, now, cutoffTime) {
    if (!this.isAlertTypeActive(ALERT_TYPES.EXIT_NOTIFICATION)) {
      this.log.debug("⏸️ Exit notifications disabled or outside time window");
      return;
    }

    // Must match known exit titles
    const isValidTitle = Object.values(EXIT_NOTIFICATION_TITLES).includes(
      notification.title
    );
    if (!isValidTitle) {
      this.log.debug(
        `🚪 Exit notification title not recognized: "${notification.title}"`
      );
      return;
    }

    // Must be recent
    const notificationTime = parseInt(notification.id) / 10000000;
    if (isNaN(notificationTime) || notificationTime < cutoffTime) {
      this.log.debug(`🚪 Exit notification too old: ${notificationTime}`);
      return;
    }

    // Deduplication
    const dedupeKey = `${Math.floor(
      notificationTime / 1000
    )}_${notification.data.sort().join(",")}_${notification.title}`;
    if (this.processedExitNotifications.has(dedupeKey)) return;
    this.processedExitNotifications.add(dedupeKey);

    this.log.info(
      `🚪 Processing exit notification: "${
        notification.title
      }" for ${notification.data.join(", ")}`
    );
    this.handleExitNotification(notification);
  }

  processFlashAlert(alert, now, cutoffTime) {
    if (!this.isAlertTypeActive(ALERT_TYPES.FLASH_SHELTER)) {
      this.log.debug("⏸️ Flash alerts disabled or outside time window");
      return;
    }

    // Check if this is a valid flash alert title
    const isValidTitle = FLASH_ALERT_TITLES.includes(alert.title);
    if (!isValidTitle) {
      this.log.debug(`🔴 Flash alert title not recognized: "${alert.title}"`);
      return;
    }

    // Must be recent
    const alertTime = parseInt(alert.id) / 10000000;
    if (isNaN(alertTime) || alertTime < cutoffTime) {
      this.log.debug(`🔴 Flash alert too old: ${alertTime}`);
      return;
    }

    // Deduplication
    const dedupeKey = `${Math.floor(alertTime / 1000)}_${JSON.stringify(
      alert.data
    )}_flash`;
    if (this.processedFlashAlerts.has(dedupeKey)) return;
    this.processedFlashAlerts.add(dedupeKey);

    this.log.info(
      `🔴 Processing flash alert: "${alert.title}" for ${JSON.stringify(
        alert.data
      )}`
    );

    // ✅ ENHANCED AREA FILTERING
    let affectedCities = [];

    // Handle different data formats
    if (Array.isArray(alert.data)) {
      // Array of cities
      affectedCities = alert.data.filter((city) =>
        this.selectedCities.includes(city)
      );
      this.log.info(
        `🔴 Flash alert data is array: ${JSON.stringify(alert.data)}`
      );
    } else if (typeof alert.data === "string") {
      // Single city or special cases
      const alertArea = alert.data;

      // Check for nationwide alerts
      if (
        alertArea === "ברחבי הארץ" ||
        alertArea === "כל אזורי ישראל" ||
        alertArea === "כל האזורים" ||
        alertArea === "מדינת ישראל"
      ) {
        this.log.info(`🔴 Nationwide flash alert detected: "${alertArea}"`);
        affectedCities = [...this.selectedCities]; // All our cities
      } else if (this.selectedCities.includes(alertArea)) {
        // Specific city match
        affectedCities = [alertArea];
        this.log.info(`🔴 Flash alert for specific city: "${alertArea}"`);
      } else {
        this.log.info(`🔴 Flash alert for non-monitored area: "${alertArea}"`);
      }
    } else {
      this.log.warn(
        `🔴 Flash alert has unexpected data format: ${typeof alert.data} - ${JSON.stringify(
          alert.data
        )}`
      );
      return;
    }

    this.log.info(
      `🔴 Affected cities after filtering: ${JSON.stringify(affectedCities)}`
    );

    if (affectedCities.length === 0) {
      this.log.info(
        `🔴 Flash alert found but none for monitored cities (${this.selectedCities.join(
          ", "
        )})`
      );
      return;
    }

    // Apply debounce
    const debouncedCities = affectedCities.filter((cityName) =>
      this.canTriggerAlert(ALERT_TYPES.FLASH_SHELTER, cityName)
    );

    if (debouncedCities.length === 0) {
      this.log.info(
        `🔴 Flash alert found for ${affectedCities.join(
          ", "
        )} but all are in debounce period`
      );
      return;
    }

    // Check priority
    if (this.isAlertActive) {
      this.log.info(`🔴 Flash alert found but skipped (primary alert active)`);
      return;
    }

    if (this.isEarlyWarningActive) {
      this.log.info("🔴 Flash alert interrupting early warning");
      this.stopEarlyWarningPlayback();
    }

    this.log.info(
      `🔴 FLASH ALERT TRIGGERED for areas: ${debouncedCities.join(", ")}`
    );
    this.triggerFlashAlert(debouncedCities);
  }

  handleExitNotification(notification) {
    if (!Array.isArray(notification.data)) {
      this.log.warn("⚠️ Exit notification missing data array");
      return;
    }

    // Check if any of our configured cities are affected
    const affectedCities = notification.data.filter((city) =>
      this.selectedCities.includes(city)
    );

    if (affectedCities.length === 0) {
      this.log.debug(
        `🚪 Exit notification found but none for monitored cities`
      );
      return;
    }

    // Check if this exit notification matches the last alert type for each city
    const relevantCities = affectedCities.filter((city) => {
      const lastAlert = this.lastAlertTypePerCity.get(city);
      if (!lastAlert) {
        this.log.debug(`🚪 No previous alert recorded for ${city}`);
        return false;
      }

      // Check if exit message matches the last alert type
      const isMatchingExit = this.doesExitMessageMatchLastAlert(
        notification.title,
        lastAlert.alertType
      );
      if (isMatchingExit) {
        this.log.debug(
          `🚪 Exit notification matches last alert type for ${city}`
        );
        // Clear the last alert record since it's now ended
        this.lastAlertTypePerCity.delete(city);
        return true;
      }

      return false;
    });

    if (relevantCities.length === 0) {
      this.log.debug(
        `🚪 Exit notification found but doesn't match last alert types`
      );
      return;
    }

    // Apply debounce
    const debouncedCities = relevantCities.filter((cityName) =>
      this.canTriggerAlert(ALERT_TYPES.EXIT_NOTIFICATION, cityName)
    );

    if (debouncedCities.length === 0) {
      this.log.info(
        `🚪 Exit notification found for ${relevantCities.join(
          ", "
        )} but all are in debounce period`
      );
      return;
    }

    this.log.info(
      `🚪 EXIT NOTIFICATION TRIGGERED for areas: ${debouncedCities.join(", ")}`
    );
    this.triggerExitNotification(debouncedCities);
  }

  doesExitMessageMatchLastAlert(exitTitle, lastAlertType) {
    // Terrorist infiltration (threat ID 2) -> terrorist exit message
    if (
      lastAlertType === 2 &&
      exitTitle === EXIT_NOTIFICATION_TITLES.TERRORIST
    ) {
      return true;
    }

    // Missile-related alerts (threat IDs 0, 5, 7) -> missile exit message
    if (
      [0, 5, 7].includes(lastAlertType) &&
      exitTitle === EXIT_NOTIFICATION_TITLES.MISSILE
    ) {
      return true;
    }

    return false;
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
      .setCharacteristic(Characteristic.Model, "Red Alert Tzofar")
      .setCharacteristic(Characteristic.SerialNumber, "3.0.0");

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

      // Clean up exit notifications
      let removed = 0;
      for (const id of this.processedExitNotifications) {
        const ts = parseInt(id.split("_")[0]);
        if (isNaN(ts) || ts < cutoff) {
          this.processedExitNotifications.delete(id);
          removed++;
        }
      }
      if (removed) {
        this.log.debug(
          `🧹 Cleaned up ${removed} processed exit notification entries`
        );
      }

      // Clean up flash alerts
      let flashRemoved = 0;
      for (const id of this.processedFlashAlerts) {
        const ts = parseInt(id.split("_")[0]);
        if (isNaN(ts) || ts < cutoff) {
          this.processedFlashAlerts.delete(id);
          flashRemoved++;
        }
      }
      if (flashRemoved) {
        this.log.debug(
          `🧹 Cleaned up ${flashRemoved} processed flash alert entries`
        );
      }

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
   * Chromecast playback with event-based completion tracking and comprehensive logging.
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

    // Track completion for event-based callback
    let devicesCompleted = 0;
    const totalDevices = validDevices.length;
    let callbackCalled = false;

    const handleDeviceComplete = (deviceName) => {
      devicesCompleted++;
      this.log.info(
        `✅ Device ${deviceName} completed (${devicesCompleted}/${totalDevices})`
      );

      if (devicesCompleted >= totalDevices && !callbackCalled) {
        callbackCalled = true;
        this.log.info(`✅ All devices completed playback for ${alertType}`);
        if (onAllComplete) onAllComplete();
      }
    };

    // Fallback timeout (longer than before since we're using events)
    const timeoutMs = Math.max(this.chromecastTimeout * 2 * 1000, 60000); // At least 60 seconds
    const timeoutHandle = setTimeout(() => {
      if (!callbackCalled) {
        callbackCalled = true;
        this.log.warn(
          `⏰ Timeout reached for ${alertType} after ${
            timeoutMs / 1000
          }s - forcing completion`
        );
        if (onAllComplete) onAllComplete();
      }
    }, timeoutMs);

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
          handleDeviceComplete(device.friendlyName); // Count as completed
          return;
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
            handleDeviceComplete(device.friendlyName);
            return;
        }

        this.log.info(
          `🏠 [Shelter] Playing ${alertType} on ${device.friendlyName} at ${volume}% volume`
        );
        this.playWithEventCompletion(
          device,
          mediaUrl,
          3,
          alertType,
          volume,
          true,
          handleDeviceComplete
        );
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
          // Mark all regular devices as completed
          regularDevices.forEach((device) =>
            handleDeviceComplete(device.friendlyName)
          );
          return;
      }

      regularDevices.forEach((device) => {
        const volume = this.getAlertVolume(alertType, device);
        this.log.info(
          `📺 [Regular] Playing ${alertType} on ${device.friendlyName} at ${volume}% volume`
        );
        this.playWithEventCompletion(
          device,
          mediaUrl,
          3,
          alertType,
          volume,
          false,
          handleDeviceComplete
        );
      });
    }

    this.log.info(
      `⏱️ Event-based completion tracking enabled with ${
        timeoutMs / 1000
      }s timeout fallback`
    );
  }

  playWithEventCompletion(
    device,
    mediaUrl,
    retries,
    alertType,
    volume,
    isShelter,
    onComplete
  ) {
    const deviceType = isShelter ? "🏠 [Shelter]" : "📺 [Regular]";

    try {
      device.play(mediaUrl, (err) => {
        if (err && retries > 0) {
          this.log.warn(
            `${deviceType} ⚠️ Playback failed on ${device.friendlyName}, retrying (${retries} attempts left): ${err.message}`
          );
          setTimeout(
            () =>
              this.playWithEventCompletion(
                device,
                mediaUrl,
                retries - 1,
                alertType,
                volume,
                isShelter,
                onComplete
              ),
            2000
          );
        } else if (err) {
          this.log.error(
            `${deviceType} ❌ Final playback failure on ${device.friendlyName}: ${err.message}`
          );
          onComplete(device.friendlyName);
        } else {
          this.log.info(
            `${deviceType} ▶️ Successfully started playback on ${device.friendlyName}`
          );

          // Set volume
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

          // Listen for finished event
          const finishedHandler = () => {
            this.log.info(
              `${deviceType} 🏁 Playback finished on ${device.friendlyName}`
            );
            device.removeListener("finished", finishedHandler);
            onComplete(device.friendlyName);
          };

          device.on("finished", finishedHandler);

          // Fallback timer per device (in case 'finished' event doesn't fire)
          setTimeout(() => {
            device.removeListener("finished", finishedHandler);
            this.log.warn(
              `${deviceType} ⏰ Device timeout on ${device.friendlyName}, marking as complete`
            );
            onComplete(device.friendlyName);
          }, 90000); // 90 second per-device timeout
        }
      });
    } catch (error) {
      this.log.error(
        `${deviceType} ❌ Connection error on ${device.friendlyName}: ${error.message}`
      );
      if (retries > 0) {
        setTimeout(
          () =>
            this.playWithEventCompletion(
              device,
              mediaUrl,
              retries - 1,
              alertType,
              volume,
              isShelter,
              onComplete
            ),
          2000
        );
      } else {
        onComplete(device.friendlyName);
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

    if (this.orefTimer) {
      clearInterval(this.orefTimer);
    }
  }
}

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerAccessory("homebridge-red-alert", "RedAlert", RedAlertPlugin);
};
