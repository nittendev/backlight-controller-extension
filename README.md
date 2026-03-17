# Backlight Controller GNOME Extension

This extension adds a sun icon to the GNOME top bar (right/status area).
It is intentionally targeted at GNOME Shell 49 only.

## What it does

- Scans `/sys/class/backlight` for all available backlight devices.
- Creates one slider per detected device.
- Automatically reads current brightness and `max_brightness`.
- Stores per-device range config (`min`/`max`) in `config.json`.
- Provides a separate Settings window for:
  - ordering backlights in the menu
  - hiding specific backlights from list view
  - renaming backlights for display in the menu
  - editing per-device slider range (`min`/`max`)
  - resetting range to auto-detected values

By default, the extension tries to write `config.json` in the extension directory. If that path is not writable, it falls back to:
`~/.config/backlight-controller/config.json`

## Install locally

`make install`
`make enable`

 * Tip: it's quite often that you need to go into extensions and manually enable it the first time on distros like Fedora.
 * I haven't bothered looking into it.


## Notes

- Writing to `/sys/class/backlight/*/brightness` may require permissions depending on your distro/udev setup.
- If writes fail, GNOME Shell will show a notification and log details in the shell logs.

## Manual verification checklist

- Open and close the indicator menu repeatedly with no aliases configured; `config.json` should not change on each open.
- Add an invalid range in `config.json` (for example `min >= max`) and reopen the menu; it should normalize once and stop rewriting.
- With the extension active, drag a brightness slider quickly; brightness should track, but writes should be coalesced (fewer repeated errors/logs).
- Temporarily make a backlight path unreadable/unavailable and reopen menu/preferences; it should skip the device instead of crashing.
