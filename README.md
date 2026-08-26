

# 🚨 Homebridge Red Alert Plugin 🚨

**Red Alert** is a Homebridge plugin for real-time civil defense alerts in Israel, supporting Chromecast devices and HomeKit integration. It provides real-time notifications for primary missile alerts, early warnings, and exit (all-clear) notifications via the Tzofar WebSocket API. All alert types are fully configurable with per-device and per-alert time and volume controls.

https://youtu.be/Bst3QFTlfBo

---

## ⚠️ Legal Disclaimer / הצהרת אחריות משפטית / إخلاء مسؤولية قانونية

### English
> This software is an independent, community project and is not produced, endorsed, maintained, or approved by any governmental entity, including but not limited to the Israeli Ministry of Defense or the Home Front Command. No relationship, partnership, or affiliation exists between the developers of this project and any government or defense body.  
>  
> The plugin is provided "as is," without any warranties, express or implied. Usage is strictly at your own risk. The developers disclaim all responsibility for any direct, indirect, incidental, or consequential damages that may arise from the use or inability to use this software.  
>  
> This software is not intended to replace or serve as a substitute for any official warning or alert system. Users are strongly advised to rely on official, government-issued alert systems for safety and emergency information.

---

### עברית
> תוכנה זו מהווה יוזמה קהילתית בלתי תלויה, ואינה מופקת, מאושרת, נתמכת או מוסדרת על ידי אף גורם ממשלתי, לרבות אך לא רק משרד הביטחון או פיקוד העורף. אין כל קשר, שותפות או זיקה בין מפתחי פרויקט זה לבין אף גוף ממשלתי או ביטחוני.  
>  
> התוסף מסופק כפי שהוא ("As-Is") ללא כל אחריות מכל סוג, מפורשת או משתמעת. השימוש בתוסף הוא על אחריות המשתמש בלבד. המפתחים מסירים כל אחריות לנזקים ישירים, עקיפים, נלווים או תוצאתיים העלולים להיגרם כתוצאה מהשימוש או מאי היכולת להשתמש בתוכנה זו.  
>  
> תוכנה זו אינה מיועדת להוות תחליף או כלי רשמי למערכות התרעה רשמיות. מומלץ למשתמשים להסתמך על מערכות התרעה רשמיות של המדינה לצרכי בטיחות וחירום בלבד.

---

### العربية
> هذا البرنامج هو مشروع مجتمعي مستقل وغير منتج أو معتمد أو مدعوم أو مصرح به من قبل أي جهة حكومية، بما في ذلك (وليس حصراً) وزارة الأمن أو الجبهة الداخلية في إسرائيل. لا توجد أي علاقة أو شراكة أو ارتباط بين مطوري هذا المشروع وأي جهة حكومية أو عسكرية.  
>  
> يتم توفير هذا البرنامج كما هو ("As-Is") دون أي ضمانات صريحة أو ضمنية. استخدامك للبرنامج على مسؤوليتك الخاصة فقط. يخلي المطورون مسؤوليتهم عن أي أضرار مباشرة أو غير مباشرة أو عرضية أو تبعية قد تنشأ عن استخدام أو عدم القدرة على استخدام هذا البرنامج.  
>  
> هذا البرنامج ليس بديلاً عن الأنظمة الرسمية للإنذار أو التحذير. يُنصح المستخدمون بالاعتماد على أنظمة الإنذار الرسمية فقط لأغراض السلامة والطوارئ.

---

## ✨ Features

- **🔌 Real-time Tzofar WebSocket** – reliable real-time alerts via official Tzofar API
- **🏠 HomeKit sensors** for:
  - Primary alert ("Red Alert") 
  - Early-warning ("בדקות הקרובות ייתכן ויופעלו התרעות")
  - Exit notification ("האירוע הסתיים")
  - Test switch for triggering test video/sound on chromecast devices
- **📺 Chromecast support** – play alert sounds/videos on one or more Chromecast devices
- **🏠 Advanced Shelter Speaker System**:
  - Dedicated ballistic protection instructions
  - Smart cooldown system to prevent instruction spam
  - Per-alert-type instruction files and volumes
  - Separate logic for shelter vs entertainment devices
- **⚙️ Per-alert-type controls**:
  - Enable/disable
  - Start/end time window (Israel time)
  - Default volume
- **🎛️ Per-device overrides**:
  - Set default and alert-type-specific volume per Chromecast device
- **🔄 Automatic deduplication** – no duplicate notifications for the same event
- **🎵 Customizable media** – provide your own videos/sounds or use included defaults
- **🏙️ City filtering** – only get notified for cities you care about

---

## 🛠️ Installation

**1. Clone this repository into your Homebridge `node_modules` directory (recommended for advanced users):**

```bash
cd /path/to/homebridge/node_modules/
git clone https://github.com/yalihart/homebridge-red-alert.git
cd homebridge-red-alert
npm install
```

**2. Restart Homebridge.**

**3. Place your alert media files**

By default, the plugin looks for the following files in  
`<homebridge-root>/red-alert-media/`:

**Standard Alert Media:**
- `alert.mp4` (primary alert)
- `early.mp4` (early warning)
- `exit.mp4` (exit notification)
- `test.mp4` (test alert)

**🏠 Shelter Instruction Media:**
- `ballistic_closure.mp4` (shelter closure instructions)
- `ballistic_windows_closed.mp4` (windows closed instructions)
- `exit.mp4` (exit instructions - can be same as standard exit)

> The plugin will auto-copy default media files if none exist.

---

## ⚙️ Configuration

Edit your Homebridge `config.json` and add an accessory of type `RedAlert`.  
Below is a **comprehensive configuration** that demonstrates all features:

```json
{
  "accessory": "RedAlert",
  "name": "Red Alert",
  "cities": ["רעננה"],
  "useChromecast": true,
  "chromecastVolume": 80,
  "chromecastTimeout": 30,
  "serverPort": 8095,
  "tzofar": {
    "enabled": true,
    "wsUrl": "wss://ws.tzevaadom.co.il/socket?platform=ANDROID",
    "reconnectInterval": 10000,
    "maxReconnectInterval": 60000,
    "maxReconnectAttempts": 10,
    "pingInterval": 60000,
    "pongTimeout": 420000
  },
  "alerts": {
    "early-warning": {
      "enabled": true,
      "startHour": 7,
      "endHour": 23,
      "volume": 65
    },
    "exit-notification": {
      "enabled": true,
      "volume": 40
    }
  },
  "chromecastVolumes": [
    {
      "deviceName": "Living Room TV",
      "volume": 40,
      "alerts": {
        "early-warning": { "volume": 25 },
        "exit-notification": { "volume": 15 }
      }
    },
    {
      "deviceName": "Bedroom TV", 
      "volume": 30,
      "alerts": {
        "early-warning": { "volume": 20 },
        "exit-notification": { "volume": 10 }
      }
    }
  ],
  "shelterInstructions": {
    "devices": [
      {
        "deviceName": "Shelter speaker",
        "enabled": true,
        "volumes": {
          "primary": 65,
          "early-warning": 65,
          "exit-notification": 60
        }
      }
    ],
    "primaryFile": "ballistic_closure.mp4",
    "earlyWarningFile": "ballistic_windows_closed.mp4", 
    "exitFile": "exit.mp4",
    "minIntervalMinutes": 20
  },
  "alertVideoPath": "alert.mp4",
  "earlyWarningVideoPath": "early.mp4",
  "exitNotificationVideoPath": "exit.mp4",
  "testVideoPath": "test.mp4"
}
```

### 🏙️ Finding Your City Key

**Important**: To configure cities, you need to find the exact JSON key from the included `cities.json` file in the plugin directory:

1. **Navigate to the plugin directory**: `node_modules/homebridge-red-alert/`
2. **Open the `cities.json` file**
3. **Search for your city name in Hebrew**
4. **Copy the JSON key exactly** (not the Hebrew name inside the object)

**Example from the included cities.json:**
```json
{
  "cities": {
    "רעננה": { "id": 1234 },           ← Use "רעננה" (the key)
    "תל אביב - יפו": { "id": 5678 },    ← Use "תל אביב - יפו" (not just "תל אביב")
    "ירושלים": { "id": 9999 }           ← Use "ירושלים" (the key)
  }
}
```

**⚠️ Important Notes:**
- Use **copy & paste** to ensure exact match
- Some cities have extended names like "תל אביב - יפו" 
- The key (left side) may differ from the display name
- Case and spacing must match exactly
- The `cities.json` file is included with the plugin and contains all Israeli cities with their official IDs

### Key Configuration Properties

| Property                      | Description                                                                                                               |
|-------------------------------|---------------------------------------------------------------------------------------------------------------------------|
| `name`                        | Accessory name as seen in HomeKit                                                                                         |
| `cities`                      | Array of cities to monitor (exact keys from included cities.json). If omitted, all cities are monitored.                 |
| `citiesJsonPath`              | Path to cities.json file (defaults to included file in plugin directory)                                                  |
| `useChromecast`               | Enable/disable Chromecast playback                                                                                        |
| `chromecastVolume`            | Default volume for Chromecast devices (0-100)                                                                             |
| `chromecastTimeout`           | How many seconds to play alert on Chromecast (fallback timeout)                                                           |
| `chromecastVolumes`           | Array of per-device overrides. Can specify `volume` for device and per-alert-type                                         |
| `shelterInstructions`         | 🏠 **Advanced shelter speaker configuration** (see below)                                                                |
| `alerts`                      | Per-alert-type configuration (see below)                                                                                  |
| `tzofar`                      | Tzofar WebSocket configuration (usually defaults are fine)                                                                |
| `serverPort`                  | Port for serving local media (Chromecast)                                                                                 |
| `baseUrl`                     | Optional base URL override for the media server (auto-detected if omitted)                                               |

#### Per-Alert-Type Configuration (`alerts`)

Each alert type (`early-warning`, `exit-notification`) supports:

- `enabled`   – Enable/disable this alert type
- `startHour` – Hour to start notifications (0-23), Israel time
- `endHour`   – Hour to end notifications (0-23), Israel time  
  - If omitted, alert is always active (24/7)
  - For overnight ranges (22-6), use `"startHour": 22, "endHour": 6`
- `volume`    – Default volume for this type (can be overridden per device)

**Note**: Primary alerts are **never time-restricted** for safety reasons.

#### Per-Device Overrides (`chromecastVolumes`)

You can set:
- A default `volume` for each Chromecast device
- Per-alert-type volume overrides (in the `alerts` object for that device)

**Volume Priority (highest to lowest):**
1. Device-specific alert volume (e.g., "Living Room TV" early-warning volume)
2. Device-specific default volume
3. Alert-type default volume  
4. Global default volume

#### 🔌 Tzofar WebSocket Configuration (`tzofar`)

Usually the defaults work fine, but you can configure:

- `enabled` – Enable/disable Tzofar WebSocket (default: true)
- `wsUrl` – WebSocket URL (default: official Tzofar endpoint)  
- `reconnectInterval` – Initial reconnect delay in ms (default: 10000)
- `maxReconnectInterval` – Maximum reconnect delay in ms (default: 60000)
- `maxReconnectAttempts` – Max reconnection attempts (default: 10)
- `pingInterval` – WebSocket ping interval in ms (default: 60000)
- `pongTimeout` – WebSocket pong timeout in ms (default: 420000)

#### 🏠 Shelter Instructions Configuration (`shelterInstructions`)

**Advanced feature for dedicated shelter/safe room speakers with ballistic protection instructions.**

```json
"shelterInstructions": {
  "devices": [
    {
      "deviceName": "Shelter speaker",
      "enabled": true,
      "volumes": {
        "primary": 65,
        "early-warning": 65,
        "exit-notification": 60
      }
    }
  ],
  "primaryFile": "ballistic_closure.mp4",
  "earlyWarningFile": "ballistic_windows_closed.mp4",
  "exitFile": "exit.mp4",
  "minIntervalMinutes": 20
}
```

**Shelter Instructions Properties:**

| Property              | Description                                                                                        |
|-----------------------|----------------------------------------------------------------------------------------------------|
| `devices`             | Array of Chromecast devices designated as shelter speakers                                        |
| `deviceName`          | Exact name of the Chromecast device (must match discovered device name)                          |
| `enabled`             | Enable/disable shelter instructions for this device                                               |
| `volumes`             | Per-alert-type volume settings for shelter instructions (0-100)                                   |
| `primaryFile`         | Audio/video file for primary alert shelter instructions                                           |
| `earlyWarningFile`    | Audio/video file for early warning shelter instructions                                           |
| `exitFile`            | Audio/video file for exit/all-clear instructions                                                  |
| `minIntervalMinutes`  | Minimum time between instruction playbacks (prevents spam, default: 20 minutes)                   |

**🔧 How Shelter Instructions Work:**

1. **Smart Device Detection**: Devices listed in `shelterInstructions.devices` get special instruction audio instead of standard alert media
2. **Cooldown System**: Early warnings have a per-device cooldown to prevent instruction spam
3. **Separate Media**: Shelter devices play ballistic protection instructions while entertainment devices play standard alerts
4. **Volume Control**: Shelter devices have separate volume settings optimized for instruction clarity
5. **Alert-Specific Logic**: 
   - **Primary alerts**: Always play closure instructions (no cooldown)
   - **Early warnings**: Play windows-closed instructions (with 20-min cooldown)
   - **Exit notifications**: Always play exit instructions (no cooldown)

**Example Use Case:**
- Your living room TV plays standard alert videos at entertainment volume
- Your shelter speaker plays specific ballistic protection instructions at higher, clearer volume
- Early warning instructions won't repeat unnecessarily (20-minute cooldown prevents spam)

---

## 🏠 HomeKit Integration

The plugin creates these HomeKit accessories:

- **"Red Alert"** – Contact sensor that triggers for primary missile alerts
- **"Red Alert Early Warning"** – Contact sensor that triggers for early-warning messages  
- **"Red Alert Exit Notification"** – Contact sensor that triggers for exit notifications
- **"Red Alert Test"** – Switch to trigger a test alert and media playback

**Sensor States:**
- **Contact Detected** = No alert (normal state)
- **Contact Not Detected** = Alert active

**Automation Ideas:**
- Turn on all lights when primary alert triggers
- Send iOS notification when early warning triggers
- Turn off automation when exit notification triggers

---

## 📺 Chromecast Integration

- **Auto-discovery**: Finds Chromecast devices on your network automatically
- **Multi-device playback**: Plays on all discovered devices simultaneously
- **Per-device volume control**: Set different volumes for different rooms
- **🏠 Dual-mode playback**: Standard devices get alert videos, shelter speakers get instruction audio
- **Event-based completion**: Alert sensors reset only when playback ends on all devices
- **Retry logic**: Automatically retries if initial playback fails
- **Smart cooldown**: Prevents instruction spam on shelter devices

**Playback Behavior:**
- Playback continues until the media file finishes playing
- HomeKit sensors remain triggered until **all** devices complete playback
- Failed devices don't block completion of successful devices
- 90-second per-device timeout with overall fallback timeout

---

## 🎥 Media Files

### Standard Alert Media
By default, the plugin expects these files under `<homebridge-root>/red-alert-media/`:

- `alert.mp4` – Primary alert (red alert/missile incoming)
- `early.mp4` – Early warning ("בדקות הקרובות ייתכן ויופעלו התרעות")  
- `exit.mp4` – Exit notification ("האירוע הסתיים באזורים")
- `test.mp4` – Test alert

### 🏠 Shelter Instruction Media
For shelter speaker devices, additional instruction files:

- `ballistic_closure.mp4` – "Close shelter immediately" instructions for primary alerts
- `ballistic_windows_closed.mp4` – "Close windows and stay protected" for early warnings  
- `exit.mp4` – "All clear, you may exit" for exit notifications

**File Format Recommendations:**
- **Video**: MP4 with H.264 video codec
- **Audio**: AAC audio codec  
- **Resolution**: 720p or 1080p for video alerts
- **Audio-only**: Use MP4 container with AAC audio (no video track needed)
- **Duration**: Keep instruction audio concise (30-60 seconds)
- **Language**: Hebrew, Arabic, English, or your preferred language

**Media Server Endpoints:**
The plugin serves media at these URLs (for debugging):
- `http://your-homebridge-ip:8095/alert-video`
- `http://your-homebridge-ip:8095/early-warning-video` 
- `http://your-homebridge-ip:8095/exit-notification-video`
- `http://your-homebridge-ip:8095/shelter-instructions-primary`
- `http://your-homebridge-ip:8095/shelter-instructions-early-warning`
- `http://your-homebridge-ip:8095/shelter-instructions-exit-notification`
- `http://your-homebridge-ip:8095/health` (health check)

---

## 🛡️ Alert Behavior & Logic

### Alert Types & Sources

| Alert Type           | Source                  | Trigger                                            | HomeKit Sensor              |
|---------------------|-------------------------|----------------------------------------------------|------------------------------|
| **Primary Alert**   | Tzofar ALERT           | Incoming missiles/threats (threat IDs 0,2,5,7)    | "Red Alert"                 |
| **Early Warning**   | Tzofar SYSTEM_MESSAGE  | "בדקות הקרובות ייתכן ויופעלו התרעות"                | "Red Alert Early Warning"   |
| **Exit Notification** | Tzofar SYSTEM_MESSAGE  | "האירוע הסתיים באזורים"                           | "Red Alert Exit Notification" |

### Standard Devices (TVs, Entertainment Systems)
- Play standard alert videos with entertainment-appropriate volumes
- Use per-device volume settings from `chromecastVolumes`
- All alerts play immediately when triggered

### 🏠 Shelter Devices (Dedicated Safety Speakers)
- Play specific ballistic protection instructions
- Use higher, clearer volumes optimized for emergency instructions
- **Smart cooldown system**:
  - **Early warnings**: 20-minute cooldown prevents repeated instructions
  - **Primary alerts**: Always play (critical safety)
  - **Exit notifications**: Always play (important all-clear)

### Alert Priority System
1. **Primary alerts** (incoming missiles) override all other alerts
2. **Early warnings** and **Exit notifications** can coexist with others
3. Each alert type maintains its own state independently

### Time-Based Filtering
- **Early warnings**: Respect `startHour`/`endHour` settings (e.g., 7 AM - 11 PM)
- **Exit notifications**: Can have time restrictions if configured
- **Primary alerts**: Always active (override time restrictions for safety)

### City Matching & Deduplication
- Alerts match against city IDs from the included `cities.json` file
- 2-minute deduplication prevents duplicate alerts for the same city/type
- Real-time WebSocket delivery for immediate notifications

---

## 🛠️ Advanced / Troubleshooting

### General Troubleshooting
- The plugin logs all actions and errors. Check the Homebridge log for details.
- If your Chromecast devices are not found, make sure they are on the same network and discoverable.
- For city names, use exact keys from the included `cities.json` file.

### 🏙️ City Configuration Issues
- **City not triggering**: Verify the city key matches exactly with the `cities.json` file
- **All cities triggering**: Remove or leave empty the `cities` array to monitor all cities
- **Unknown city error**: Check that the city exists in the included `cities.json` file

### 🔌 Tzofar WebSocket Issues
- **Connection failures**: Check internet connectivity and firewall settings
- **Frequent reconnections**: Default settings handle temporary disconnections automatically
- **No alerts received**: Verify Tzofar service is operational and your cities are configured correctly

### 🏠 Shelter Instructions Troubleshooting
- **Instructions not playing**: Check that `deviceName` exactly matches your Chromecast's name
- **Volume too low/high**: Adjust per-alert volumes in `shelterInstructions.devices[].volumes`
- **Instructions repeating**: Check `minIntervalMinutes` setting (default 20 minutes)
- **Wrong audio playing**: Verify media file paths in `shelterInstructions` configuration

### Debug Logging
Enable debug logging to see detailed behavior:
```
[Tzofar] Connected to WebSocket
[Shelter] Playing primary instructions on Shelter speaker at volume 65%
[Shelter] Skipping early-warning instructions on Shelter speaker (cooldown active)
[Volume] Living Room TV: 25% (source: device-specific early-warning)
```

### Media Server Issues
- **404 errors**: Check that media files exist in the `red-alert-media` directory
- **Playback failures**: Verify file formats are compatible (MP4/H.264/AAC recommended)
- **Server not starting**: Check that the configured port is available

---

## 🧑‍💻 Upgrading / Customization

- You can replace the video files with your own (same filename, or override the path in config).
- To add more cities, just add them to the `cities` array using exact keys from `cities.json`.
- To monitor all cities, remove the `cities` property entirely.
- **🏠 For shelter speakers**: Record custom instruction audio in your preferred language and replace the default files.

### Creating Custom Shelter Instructions

**Recommended content for instruction files:**

1. **Primary Alert** (`ballistic_closure.mp4`):
   - Hebrew: "פגיעה צפויה - סגרו את המרחב המוגן מיד"
   - English: "Incoming impact - close shelter immediately"
   - Arabic: "قصف متوقع - أغلقوا الملجأ فوراً"

2. **Early Warning** (`ballistic_windows_closed.mp4`):
   - Hebrew: "סגרו חלונות והישארו במרחב מוגן"  
   - English: "Close windows and remain in protected space"
   - Arabic: "أغلقوا النوافذ وابقوا في المكان المحمي"

3. **Exit Notification** (`exit.mp4`):
   - Hebrew: "ניתן לצאת מהמרחב המוגן"
   - English: "You may exit the shelter"
   - Arabic: "يمكنكم الخروج من الملجأ"

### Configuration Examples

**Minimal Configuration:**
```json
{
  "accessory": "RedAlert",
  "name": "Red Alert",
  "cities": ["רעננה"]
}
```

**Family Home with Multiple Rooms:**
```json
{
  "accessory": "RedAlert",
  "name": "Red Alert",
  "cities": ["רעננה", "תל אביב - יפו"],
  "alerts": {
    "early-warning": {
      "startHour": 7,
      "endHour": 22,
      "volume": 60
    }
  },
  "chromecastVolumes": [
    {
      "deviceName": "Living Room TV",
      "volume": 50,
      "alerts": {
        "early-warning": { "volume": 30 },
        "exit-notification": { "volume": 20 }
      }
    },
    {
      "deviceName": "Bedroom TV",
      "volume": 25,
      "alerts": {
        "early-warning": { "volume": 15 },
        "exit-notification": { "volume": 10 }
      }
    }
  ]
}
```

**Business/Office Setup:**
```json
{
  "accessory": "RedAlert",
  "name": "Office Red Alert",
  "cities": ["תל אביב - יפו"],
  "alerts": {
    "early-warning": {
      "startHour": 8,
      "endHour": 18,
      "volume": 70
    },
    "exit-notification": {
      "startHour": 8,
      "endHour": 18,
      "volume": 50
    }
  }
}
```

---

## 🤝 Contributing & Contact

Please feel free to **create pull requests, request features, report issues, or contact me for any reason**.  
I am happy to help and welcome contributions from anyone!

### 🇮🇱 עם ישראל חי 🇮🇱

---

## 🙏 Credits

- [Tzofar API](https://www.tzevaadom.co.il/) - Real-time alert WebSocket service
- [OREF](https://www.oref.org.il/) - Israeli Home Front Command
- [chromecast-api](https://github.com/alxhotel/chromecast-api)
- Homebridge community and HomeKit

---

## 📝 License

MIT

---

## 📋 Version History

### v4.0.0 (2025-06-19)
- **🔌 Tzofar-Only Implementation**: Complete transition to Tzofar WebSocket for all alert types
- **❌ Removed**: OREF polling, flash alerts (not supported by Tzofar)
- **✅ Added**: Real-time exit notifications via Tzofar SYSTEM_MESSAGE
- **🏠 Enhanced**: Shelter instruction system with improved logic
- **⚡ Improved**: Single WebSocket connection for better reliability

### v3.x.x (Previous)
- OREF polling + Tzofar WebSocket hybrid approach
- Flash alert support via OREF API
- Multiple data sources and polling intervals
