---
name: phone-control
description: Drive the user's Android phone from this computer with adb over wireless debugging (screenshots, taps, typing). Use when the user asks you to look at, test or operate something on their phone, or to install or check the Ringback app. Guides them through the one-time wireless debugging pairing. The Ringback app itself never controls the phone.
---

# Phone control with wireless adb

On a live call, try the `use_my_phone` tool first. It works only on a build that includes
Ringback's accessibility service, with the switch on in Ringback settings; public builds do not
have it, and it answers `not_found` there. Otherwise use Android's own developer tool, adb, from
this computer, as below.

## One-time setup (the user does this on the phone, you guide)

1. Check adb exists: `adb version`. If missing, point them to Android SDK Platform-Tools
   (developer.android.com/tools/releases/platform-tools) and wait.
2. Developer options: Settings > About phone > Software information > tap Build number 7 times.
3. Settings > Developer options > Wireless debugging: on. The phone must be on Wi-Fi.
4. Tap "Pair device with pairing code". The phone shows an IP:port and a 6 digit code. Ask the
   user to read them to you, then run: `adb pair <ip>:<pairing-port> <code>`.
   Pairing is per computer and is remembered.
5. Connect: on the Wireless debugging screen the phone shows "IP address & Port" (a different
   port than the pairing one). Run `adb connect <ip>:<port>`. When the phone and this computer
   are both on Tailscale, the phone's Tailscale address works too (it is in
   `~/.ringback/config.json` under `phone.hosts`, the 100.x address), with the same port.
6. Check: `adb devices` lists it as `device`.

## Using it

- Always check the foreground app first and never interrupt what the user is doing:
  `adb shell dumpsys activity activities | grep topResumedActivity`
  (on Windows: `| findstr topResumedActivity`). If another app is in front and the user did not
  ask you to switch, stop and ask.
- Screenshot: `adb exec-out screencap -p > phone.png`, then read the image.
- Tap / swipe / type: `adb shell input tap X Y`, `adb shell input swipe X1 Y1 X2 Y2 300`,
  `adb shell input text "hello"` (spaces as `%s`), keys: `adb shell input keyevent KEYCODE_BACK`.
- Install an APK: `adb install -r app.apk`. Never during an active call.
- Confirm with the user before anything that sends, pays, deletes or installs.

## Caveats to tell the user

- Wireless debugging only runs on Wi-Fi. On mobile data it switches off.
- The connect port changes every time wireless debugging is toggled or the phone restarts:
  read the new port from the Wireless debugging screen and `adb connect` again.
- Pairing is per computer: another computer must pair again.
- Turn Wireless debugging off when done if they do not want it left on.
