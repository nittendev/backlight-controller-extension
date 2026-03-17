import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    applyRangeUpdate,
    createInitialConfig,
    effectiveOrder,
    normalizeAlias,
    normalizeConfig,
    normalizeRange,
} from './logic.js';

const SYS_BACKLIGHT_DIR = '/sys/class/backlight';

export default class BacklightControllerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(700, 520);

        this._configPath = this._resolveConfigPath();
        this._config = this._loadConfig();
        this._readErrorByPath = new Map();
        this._backlightInfo = this._scanBacklightInfo();
        this._devices = this._getAllKnownDevices();

        const page = new Adw.PreferencesPage();
        const menuGroup = new Adw.PreferencesGroup({
            title: 'Backlights',
            description: 'Configure ordering and visibility in the top bar menu.',
        });
        const rangeGroup = new Adw.PreferencesGroup({
            title: 'Brightness Range',
            description: 'Set slider minimum/maximum values for each backlight.',
        });

        page.add(menuGroup);
        page.add(rangeGroup);
        window.add(page);

        this._rowsByName = new Map();
        this._rangeRowsByName = new Map();
        for (const name of this._devices)
            menuGroup.add(this._createDeviceRow(name));
        for (const name of this._devices)
            rangeGroup.add(this._createRangeRow(name));
        this._refreshRows();
        this._refreshRangeRows();
    }

    _createDeviceRow(name) {
        const row = new Adw.ActionRow({
            title: name,
        });

        const aliasEntry = new Gtk.Entry({
            placeholder_text: 'Display name',
            text: this._getAlias(name),
            valign: Gtk.Align.CENTER,
            width_chars: 16,
            max_width_chars: 24,
        });
        aliasEntry.connect('activate', () => {
            this._setAlias(name, aliasEntry.text);
            this._refreshRows();
        });
        aliasEntry.connect('notify::has-focus', () => {
            if (aliasEntry.has_focus)
                return;
            this._setAlias(name, aliasEntry.text);
            this._refreshRows();
        });
        row.add_suffix(aliasEntry);

        const hideToggle = new Gtk.Switch({
            active: !this._isHidden(name),
            valign: Gtk.Align.CENTER,
        });
        hideToggle.connect('notify::active', () => {
            this._setHidden(name, !hideToggle.active);
        });
        row.add_suffix(hideToggle);

        const upButton = new Gtk.Button({
            icon_name: 'go-up-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Move up',
        });
        upButton.connect('clicked', () => {
            this._moveInOrder(name, -1);
            this._refreshRows();
        });
        row.add_suffix(upButton);

        const downButton = new Gtk.Button({
            icon_name: 'go-down-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Move down',
        });
        downButton.connect('clicked', () => {
            this._moveInOrder(name, 1);
            this._refreshRows();
        });
        row.add_suffix(downButton);

        this._rowsByName.set(name, {
            row,
            aliasEntry,
            hideToggle,
            upButton,
            downButton,
        });
        return row;
    }

    _createRangeRow(name) {
        const row = new Adw.ActionRow({
            title: name,
        });

        const minLabel = new Gtk.Label({
            label: 'Min',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(minLabel);

        const minSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 1000000,
                step_increment: 1,
                page_increment: 10,
            }),
            numeric: true,
            valign: Gtk.Align.CENTER,
            width_chars: 6,
        });
        minSpin.connect('value-changed', () => {
            if (this._isRefreshingRangeRows)
                return;
            this._setDeviceRange(name, minSpin.get_value_as_int(), null);
            this._refreshRangeRows();
        });
        row.add_suffix(minSpin);

        const maxLabel = new Gtk.Label({
            label: 'Max',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(maxLabel);

        const maxSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 1000000,
                step_increment: 1,
                page_increment: 10,
            }),
            numeric: true,
            valign: Gtk.Align.CENTER,
            width_chars: 6,
        });
        maxSpin.connect('value-changed', () => {
            if (this._isRefreshingRangeRows)
                return;
            this._setDeviceRange(name, null, maxSpin.get_value_as_int());
            this._refreshRangeRows();
        });
        row.add_suffix(maxSpin);

        const resetButton = new Gtk.Button({
            label: 'Auto',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Reset range to auto-detected maximum',
        });
        resetButton.connect('clicked', () => {
            this._resetDeviceRange(name);
            this._refreshRangeRows();
        });
        row.add_suffix(resetButton);

        this._rangeRowsByName.set(name, {
            row,
            minSpin,
            maxSpin,
        });
        return row;
    }

    _refreshRows() {
        const ordered = this._effectiveOrder(this._devices);
        const lastIndex = ordered.length - 1;
        ordered.forEach((name, index) => {
            const widgets = this._rowsByName.get(name);
            if (!widgets)
                return;
            widgets.row.title = `${index + 1}. ${name}`;
            widgets.aliasEntry.text = this._getAlias(name);
            widgets.hideToggle.active = !this._isHidden(name);
            widgets.upButton.sensitive = index > 0;
            widgets.downButton.sensitive = index < lastIndex;
        });
    }

    _refreshRangeRows() {
        this._isRefreshingRangeRows = true;
        try {
            for (const name of this._devices) {
                const widgets = this._rangeRowsByName.get(name);
                if (!widgets)
                    continue;

                const range = this._getRangeForDevice(name);
                widgets.minSpin.set_value(range.min);
                widgets.maxSpin.set_value(range.max);
                widgets.minSpin.set_range(0, Math.max(0, range.max - 1));
                widgets.maxSpin.set_range(range.min + 1, Math.max(range.min + 1, range.autoMax * 4));

                const info = this._backlightInfo.get(name);
                if (info) {
                    widgets.row.subtitle = `Detected max: ${info.detectedMax}, current: ${info.current}`;
                } else {
                    widgets.row.subtitle = `Detected max: ${range.autoMax} (device not currently available)`;
                }
            }
        } finally {
            this._isRefreshingRangeRows = false;
        }
    }

    _moveInOrder(name, delta) {
        const order = this._effectiveOrder(this._devices);
        const index = order.indexOf(name);
        if (index === -1)
            return;

        const target = index + delta;
        if (target < 0 || target >= order.length)
            return;

        [order[index], order[target]] = [order[target], order[index]];
        this._config.settings.order = order;
        this._saveConfig();
    }

    _setHidden(name, hidden) {
        const hiddenSet = new Set(this._config.settings.hidden ?? []);
        if (hidden)
            hiddenSet.add(name);
        else
            hiddenSet.delete(name);
        this._config.settings.hidden = [...hiddenSet];
        this._saveConfig();
        this._refreshRows();
    }

    _setAlias(name, alias) {
        const normalizedAlias = normalizeAlias(alias);
        const existing = this._config.backlights[name] ?? {};
        const currentAlias = typeof existing.alias === 'string' ? existing.alias : '';
        if (normalizedAlias === currentAlias)
            return;

        if (normalizedAlias)
            this._config.backlights[name] = {...existing, alias: normalizedAlias};
        else
            this._config.backlights[name] = this._withoutAlias(existing);

        this._saveConfig();
    }

    _setDeviceRange(name, min, max) {
        this._config.backlights[name] = applyRangeUpdate(this._config.backlights[name], min, max);
        this._saveConfig();
    }

    _resetDeviceRange(name) {
        const existing = this._config.backlights[name];
        if (!existing)
            return;

        this._config.backlights[name] = {
            min: 0,
            max: existing.autoMax ?? existing.max ?? 1,
            autoMax: existing.autoMax ?? existing.max ?? 1,
        };
        this._saveConfig();
    }

    _getRangeForDevice(name) {
        const info = this._backlightInfo.get(name);
        const {min, max, autoMax} = normalizeRange(
            this._config.backlights[name] ?? {},
            info?.detectedMax ?? null
        );
        if (!this._config.backlights[name] ||
            this._config.backlights[name].min !== min ||
            this._config.backlights[name].max !== max ||
            this._config.backlights[name].autoMax !== autoMax) {
            this._config.backlights[name] = {min, max, autoMax};
            this._saveConfig();
        }
        return {min, max, autoMax};
    }

    _isHidden(name) {
        return (this._config.settings.hidden ?? []).includes(name);
    }

    _getAlias(name) {
        const value = this._config.backlights?.[name]?.alias;
        return typeof value === 'string' ? value : '';
    }

    _effectiveOrder(names) {
        return effectiveOrder(names, this._config.settings.order ?? []);
    }

    _getAllKnownDevices() {
        const discovered = this._backlightInfo ?
            [...this._backlightInfo.keys()].sort((a, b) => a.localeCompare(b)) :
            this._scanBacklightNames();
        const known = new Set(discovered);
        for (const name of Object.keys(this._config.backlights))
            known.add(name);
        for (const name of this._config.settings.order)
            known.add(name);
        for (const name of this._config.settings.hidden)
            known.add(name);
        return this._effectiveOrder([...known]);
    }

    _scanBacklightNames() {
        return [...this._scanBacklightInfo().keys()]
            .sort((a, b) => a.localeCompare(b));
    }

    _scanBacklightInfo() {
        const dir = Gio.File.new_for_path(SYS_BACKLIGHT_DIR);
        const byName = new Map();
        try {
            const enumerator = dir.enumerate_children(
                Gio.FILE_ATTRIBUTE_STANDARD_NAME,
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                const basePath = GLib.build_filenamev([SYS_BACKLIGHT_DIR, name]);
                const current = this._readInt(GLib.build_filenamev([basePath, 'brightness']));
                const detectedMax = this._readInt(GLib.build_filenamev([basePath, 'max_brightness']));
                if (current === null || detectedMax === null)
                    continue;
                byName.set(name, {current, detectedMax});
            }
        } catch (error) {
            console.error(`[Backlight Controller] Failed to read ${SYS_BACKLIGHT_DIR}: ${error}`);
            return new Map();
        }

        return byName;
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

    _withoutAlias(config) {
        const next = {...config};
        delete next.alias;
        return next;
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
        return GLib.build_filenamev([fallbackDir, 'config.json']);
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
}
