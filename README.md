# 🚨 Homebridge Red Alert Plugin 🚨

**Red Alert** is a Homebridge plugin for real-time civil defense alerts in Israel, supporting Chromecast devices and HomeKit integration. It provides real-time notifications for primary missile alerts, early warnings, flash (shelter) alerts, and exit (all-clear) notifications. All alert types are fully configurable with per-device and per-alert time and volume controls.

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

- **Real-time monitoring** of Israeli civil defense alerts (OREF API & WebSocket)
- **HomeKit sensors** for:
  - Primary alert ("Red Alert")
  - Early-warning ("בדקות הקרובות צפויות להתקבל התרעות באזורך")
  - Flash/shelter warning ("שהייה בסמיכות למרחב מוגן")
  - Exit notification ("ניתן לצאת מהמרחב המוגן")
  - Test switch for triggering alerts manually
- **Chromecast support** – play alert sounds/videos on one or more Chromecast devices
- **Per-alert-type controls**:
  - Enable/disable
  - Start/end time window
  - Default volume
- **Per-device overrides**:
  - Set default and alert-type-specific volume per Chromecast device
- **Automatic deduplication** – no duplicate notifications for the same event
- **Customizable media** – provide your own videos/sounds or use included defaults
- **City filtering** – only get notified for cities you care about

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
`<homebridge-root>/red-alert-media/videos/`:
- `alert.mp4` (primary alert)
- `early.mp4` (early warning)
- `flash-shelter.mp4` (flash/shelter warning)
- `exit.mp4` (exit notification)
- `test.mp4` (test alert)

> The plugin will auto-copy default media files if none exist.

---

## ⚙️ Configuration

Edit your Homebridge `config.json` and add an accessory of type `RedAlert`.  
Below is a **sample configuration** that demonstrates all features:

```json
{
  "accessory": "RedAlert",
  "name": "Red Alert",
  "cities": ["רעננה"],
  "useChromecast": true,
  "chromecastVolume": 90,
  "chromecastTimeout": 30,
  "serverPort": 8095,
  "wsUrl": "ws://ws.cumta.morhaviv.com:25565/ws",
  "reconnectInterval": 5000,
  "orefHistoryUrl": "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json",
  "alerts": {
    "early-warning": {
      "enabled": true,
      "startHour": 9,
      "endHour": 21,
      "volume": 80
    },
    "flash-shelter": {
      "enabled": true,
      "volume": 80
    },
    "exit-notification": {
      "enabled": true,
      "volume": 40
    }
  },
  "chromecastVolumes": [
    {
      "deviceName": "Yali's TV",
      "volume": 40,
      "alerts": {
        "early-warning": { "volume": 25 },
        "flash-shelter": { "volume": 20 },
        "exit-notification": { "volume": 15 }
      }
    }
  ],
  "alertVideoPath": "videos/alert.mp4",
  "earlyWarningVideoPath": "videos/early.mp4",
  "flashAlertShelterVideoPath": "videos/flash-shelter.mp4",
  "exitNotificationVideoPath": "videos/exit.mp4",
  "testVideoPath": "videos/test.mp4"
}
```

> **⏰ Alert time filtering is strictly based on the system clock of your Homebridge device.  
> If your device's time is incorrect, alerts may be suppressed or mis-timed.  
> Please ensure your device's date and time are accurate and synchronized to a trusted time source.**

### Key Configuration Properties

| Property                      | Description                                                                                                               |
|-------------------------------|---------------------------------------------------------------------------------------------------------------------------|
| `name`                        | Accessory name as seen in HomeKit                                                                                         |
| `cities`                      | Array of cities to monitor (in Hebrew, as received from OREF). If omitted, all cities are monitored.                      |
| `useChromecast`               | Enable/disable Chromecast playback                                                                                        |
| `chromecastVolume`            | Default volume for Chromecast devices (0-100).                                                                            |
| `chromecastTimeout`           | How many seconds to play alert on Chromecast (fallback for HomeKit only; Chromecast playback always runs until media ends)|
| `chromecastVolumes`           | Array of per-device overrides. Can specify `volume` for device and per-alert-type.                                        |
| `alerts`                      | Per-alert-type configuration (see below)                                                                                  |
| `alertVideoPath`, ...         | Path to video files for each alert type, relative to `red-alert-media` (defaults provided, only override if you want)     |
| `wsUrl`, `orefHistoryUrl`     | URLs for real-time and polling APIs (advanced, should not need to change)                                                 |
| `earlyWarningPollInterval`    | How often (ms) to poll for early warnings, flash, and exit notifications                                                  |
| `serverPort`                  | Port for serving local media (Chromecast)                                                                                 |

#### Per-Alert-Type Configuration (`alerts`)

Each alert type (`early-warning`, `flash-shelter`, `exit-notification`) supports:

- `enabled`   – Enable/disable this alert type
- `startHour` – Hour to start notifications (0-23), inclusive
- `endHour`   – Hour to end notifications (0-23), exclusive;  
  - If both are `0`, alert is 24/7
  - If omitted, alert is always active
- `volume`    – Default volume for this type (can be overridden per device)

#### Per-Device Overrides (`chromecastVolumes`)

You can set:
- A default `volume` for each Chromecast device
- Per-alert-type volume overrides (in the `alerts` object for that device)

---

## 🏠 HomeKit Integration

- **Red Alert Sensor** – triggers for primary missile alerts
- **Early Warning Sensor** – triggers for early-warning messages
- **Flash Alert Sensor** – triggers for "stay near shelter" messages
- **Exit Notification Sensor** – triggers for "ניתן לצאת מהמרחב המוגן"
- **Test Switch** – triggers a test alert and media playback

---

## 📺 Chromecast Integration

- Discovers Chromecast devices on your network automatically
- Plays relevant video for each alert type, on all devices
- Per-device and per-alert-type volume controls
- **Playback on Chromecast ends only when the video finishes playing.** Alert sensors reset only after playback ends on all devices.
- Retries playback if initial attempt fails

---

## 🎥 Media Files

By default, the plugin expects these files under `<homebridge-root>/red-alert-media/videos/`:

- `alert.mp4` – Main alert (primary)
- `early.mp4` – Early warning
- `flash-shelter.mp4` – Flash/shelter warning
- `exit.mp4` – Exit notification ("ניתן לצאת מהמרחב המוגן")
- `test.mp4` – Test

If you don't specify your own, the plugin will auto-copy its default media on first run.

---

## 🛠️ Advanced / Troubleshooting

- The plugin logs all actions and errors. Check the Homebridge log for details.
- If your Chromecast devices are not found, make sure they are on the same network and discoverable.
- For OREF city names, use the exact Hebrew as used by the OREF system.

---

## 🧑‍💻 Upgrading / Customization

- You can replace the video files with your own (same filename, or override the path in config).
- To add more cities, just add them to the `cities` array.
- To monitor all cities, remove the `cities` property.

---

## 🤝 Contributing & Contact

Please feel free to **create pull requests, request features, report issues, or contact me for any reason**.  
I am happy to help and welcome contributions from anyone!

### 🇮🇱 עם ישראל חי 🇮🇱

---

## 🙏 Credits

- [OREF API](https://www.oref.org.il/)
- [chromecast-api](https://github.com/alxhotel/chromecast-api)
- Cumta Realtime Alert System (WS)
- Homebridge community and HomeKit

---

## 📝 License

MIT

---

