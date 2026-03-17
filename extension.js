import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    applyRangeUpdate,
    clamp,
    createInitialConfig,
    normalizeAlias,
    normalizeConfig,
    sortDevicesByOrder,
} from './logic.js';

const SYS_BACKLIGHT_DIR = '/sys/class/backlight';

const BacklightIndicator = GObject.registerClass(
class BacklightIndicator extends PanelMenu.Button {
    constructor(extension) {
        super(0.0, 'Backlight Controller Indicator');
        this._extension = extension;
        this._writeErrorByDevice = new Map();
        this._pendingBrightnessByDevice = new Map();
        this._debounceSourceByDevice = new Map();

        this._icon = new St.Icon({
            icon_name: 'weather-clear-symbolic',
            style_class: 'system-status-icon',
        });

        this.add_child(this._icon);
        this._rebuildMenu();

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen)
                return;
            this._writeErrorByDevice.clear();
            this._rebuildMenu();
        });
    }

    destroy() {
        for (const sourceId of this._debounceSourceByDevice.values())
            GLib.source_remove(sourceId);
        this._debounceSourceByDevice.clear();
        this._pendingBrightnessByDevice.clear();
        super.destroy();
    }

    _rebuildMenu() {
        this.menu.removeAll();

        const devices = this._extension.getVisibleBacklights();
        if (devices.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No backlights found in /sys/class/backlight',
                {reactive: false}
            ));
        } else {
            devices.forEach((device, index) => {
                this._addDeviceMenu(device);
                if (index < devices.length - 1)
                    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            });
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = new PopupMenu.PopupMenuItem('Settings...');
        settingsItem.connect('activate', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    _addDeviceMenu(device) {
        const sliderItem = new PopupMenu.PopupBaseMenuItem({activate: false});
        sliderItem.style = 'padding-top: 8px; padding-bottom: 8px;';
        const row = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        const nameLabel = new St.Label({
            text: device.displayName,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            style: 'margin-bottom: 6px;',
        });
        const slider = new Slider.Slider(
            this._extension.toSliderValue(device.current, device.min, device.max)
        );
        slider.x_expand = true;
        slider.y_align = Clutter.ActorAlign.END;
        slider.style = 'margin-left: 2px; margin-right: 2px;';
        row.add_child(nameLabel);
        row.add_child(slider);
        sliderItem.add_child(row);
        this.menu.addMenuItem(sliderItem);

        slider.connect('notify::value', () => {
            const target = this._extension.fromSliderValue(
                slider.value,
                device.min,
                device.max
            );
            this._scheduleBrightnessWrite(device.name, target);
        });
    }

    _scheduleBrightnessWrite(deviceName, value) {
        this._pendingBrightnessByDevice.set(deviceName, value);
        if (this._debounceSourceByDevice.has(deviceName))
            return;

        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            this._debounceSourceByDevice.delete(deviceName);
            const target = this._pendingBrightnessByDevice.get(deviceName);
            this._pendingBrightnessByDevice.delete(deviceName);
            if (target !== undefined)
                this._writeBrightness(deviceName, target);
            return GLib.SOURCE_REMOVE;
        });
        this._debounceSourceByDevice.set(deviceName, sourceId);
    }

    _writeBrightness(deviceName, value) {
        const ok = this._extension.writeBrightness(deviceName, value);
        if (ok) {
            this._writeErrorByDevice.set(deviceName, false);
            return;
        }

        if (this._writeErrorByDevice.get(deviceName))
            return;

        this._writeErrorByDevice.set(deviceName, true);
        Main.notify('Backlight Controller', `Failed to write ${deviceName} brightness`);
    }
});

export default class BacklightControllerExtension extends Extension {
    enable() {
        this._configPath = this._resolveConfigPath();
        this._config = this._loadConfig();
        this._readErrorByPath = new Map();
        this._indicator = new BacklightIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._readErrorByPath = null;
        this._config = null;
        this._configPath = null;
    }

    getVisibleBacklights() {
        const allDevices = this.scanBacklights();
        return allDevices.filter(device => !this._isBacklightHidden(device.name));
    }

    scanBacklights() {
        this._config = this._loadConfig();

        const dir = Gio.File.new_for_path(SYS_BACKLIGHT_DIR);
        let entries = [];
        try {
            const enumerator = dir.enumerate_children(
                Gio.FILE_ATTRIBUTE_STANDARD_NAME,
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info;
            while ((info = enumerator.next_file(null)) !== null)
                entries.push(info.get_name());
        } catch (error) {
            console.error(`[Backlight Controller] Failed to read ${SYS_BACKLIGHT_DIR}: ${error}`);
            return [];
        }

        let changed = false;
        const devices = [];
        for (const name of entries) {
            const basePath = GLib.build_filenamev([SYS_BACKLIGHT_DIR, name]);
            const current = this._readInt(GLib.build_filenamev([basePath, 'brightness']));
            const detectedMax = this._readInt(GLib.build_filenamev([basePath, 'max_brightness']));
            if (current === null || detectedMax === null)
                continue;

            const existing = this._config.backlights[name] ?? {};
            const min = Number.isInteger(existing.min) ? existing.min : 0;
            const max = Number.isInteger(existing.max) ? existing.max : detectedMax;
            const clampedMax = Math.max(max, min + 1);
            const clampedCurrent = clamp(current, min, clampedMax);
            const alias = normalizeAlias(existing.alias);
            const storedAlias = normalizeAlias(this._config.backlights[name]?.alias);

            if (!this._config.backlights[name] ||
                this._config.backlights[name].min !== min ||
                this._config.backlights[name].max !== clampedMax ||
                this._config.backlights[name].autoMax !== detectedMax ||
                storedAlias !== alias) {
                this._config.backlights[name] = {
                    min,
                    max: clampedMax,
                    autoMax: detectedMax,
                    ...(alias ? {alias} : {}),
                };
                changed = true;
            }

            devices.push({
                name,
                displayName: alias || name,
                current: clampedCurrent,
                min,
                max: clampedMax,
                detectedMax,
            });
        }

        if (changed)
            this._saveConfig();

        return this._sortByConfiguredOrder(devices);
    }

    setDeviceRange(name, min, max) {
        this._config.backlights[name] = applyRangeUpdate(this._config.backlights[name], min, max);
        this._saveConfig();
    }

    resetDeviceRange(name) {
        const existing = this._config.backlights[name];
        if (!existing)
            return;

        this._config.backlights[name] = {
            min: 0,
            max: existing.autoMax ?? existing.max ?? 1,
            autoMax: existing.autoMax ?? existing.max ?? 1,
            ...(existing.alias ? {alias: existing.alias} : {}),
        };
        this._saveConfig();
    }

    toSliderValue(current, min, max) {
        const span = Math.max(1, max - min);
        return clamp((current - min) / span, 0, 1);
    }

    fromSliderValue(value, min, max) {
        const span = Math.max(1, max - min);
        return Math.round(min + span * clamp(value, 0, 1));
    }

    writeBrightness(deviceName, value) {
        const path = GLib.build_filenamev([SYS_BACKLIGHT_DIR, deviceName, 'brightness']);
        return this._writeSysfsText(path, `${value}\n`);
    }

    _loadConfig() {
        const initial = createInitialConfig();
        let ok = false;
        let bytes = null;
        try {
            [ok, bytes] = GLib.file_get_contents(this._configPath);
        } catch (error) {
            const isMissingFile = typeof error.matches === 'function' &&
                error.matches(GLib.file_error_quark(), GLib.FileError.NOENT);
            if (!isMissingFile)
                console.error(`[Backlight Controller] Failed to read config: ${error}`);
            return initial;
        }

        if (!ok)
            return initial;

        try {
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            return normalizeConfig(parsed);
        } catch (error) {
            console.error(`[Backlight Controller] Failed to parse config: ${error}`);
            return initial;
        }
    }

    _saveConfig() {
        const text = JSON.stringify(this._config, null, 2);
        if (this._writeText(this._configPath, `${text}\n`))
            return;

        console.error(`[Backlight Controller] Failed to save config at ${this._configPath}`);
    }

    _resolveConfigPath() {
        const preferred = GLib.build_filenamev([this.path, 'config.json']);
        if (this._canWritePath(preferred))
            return preferred;

        const fallbackDir = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'backlight-controller',
        ]);
        GLib.mkdir_with_parents(fallbackDir, 0o755);
        const fallback = GLib.build_filenamev([fallbackDir, 'config.json']);
        console.log(`[Backlight Controller] Using fallback config path: ${fallback}`);
        return fallback;
    }

    _canWritePath(path) {
        try {
            const parent = Gio.File.new_for_path(path).get_parent();
            if (!parent)
                return false;
            const info = parent.query_info(
                'access::can-write',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            return info.get_attribute_boolean('access::can-write');
        } catch (error) {
            return false;
        }
    }

    _writeText(path, text) {
        try {
            const file = Gio.File.new_for_path(path);
            file.replace_contents(
                new TextEncoder().encode(text),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            return true;
        } catch (error) {
            console.error(`[Backlight Controller] Write failed for ${path}: ${error}`);
            return false;
        }
    }

    _writeSysfsText(path, text) {
        let stream = null;
        try {
            const file = Gio.File.new_for_path(path);
            stream = file.replace(
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null
            );
            stream.write_all(new TextEncoder().encode(text), null);
            return true;
        } catch (error) {
            console.error(`[Backlight Controller] Sysfs write failed for ${path}: ${error}`);
            return false;
        } finally {
            if (stream) {
                try {
                    stream.close(null);
                } catch (_) {
                }
            }
        }
    }

    _readInt(path) {
        let ok = false;
        let bytes = null;
        try {
            [ok, bytes] = GLib.file_get_contents(path);
        } catch (error) {
            this._logReadErrorOnce(path, error);
            return null;
        }

        if (!ok || !bytes)
            return null;

        this._readErrorByPath?.delete(path);
        const value = Number.parseInt(new TextDecoder().decode(bytes).trim(), 10);
        return Number.isNaN(value) ? null : value;
    }

    _logReadErrorOnce(path, error) {
        const message = `${error}`;
        if (this._readErrorByPath?.get(path) === message)
            return;
        this._readErrorByPath?.set(path, message);
        console.error(`[Backlight Controller] Read failed for ${path}: ${error}`);
    }

    _sortByConfiguredOrder(devices) {
        return sortDevicesByOrder(devices, this._config?.settings?.order ?? []);
    }

    _isBacklightHidden(name) {
        const hidden = this._config?.settings?.hidden ?? [];
        return hidden.includes(name);
    }
}
