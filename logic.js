export function createInitialConfig() {
    return {version: 1, backlights: {}, settings: {order: [], hidden: []}};
}

export function normalizeAlias(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function sanitizeNameList(values) {
    if (!Array.isArray(values))
        return [];
    return values.filter(name => typeof name === 'string');
}

export function normalizeConfig(raw) {
    const initial = createInitialConfig();
    if (typeof raw !== 'object' || raw === null)
        return initial;

    const settings = typeof raw.settings === 'object' && raw.settings !== null ?
        raw.settings : {};
    const normalized = {
        version: Number.isInteger(raw.version) ? raw.version : 1,
        backlights: {},
        settings: {
            order: sanitizeNameList(settings.order),
            hidden: sanitizeNameList(settings.hidden),
        },
    };

    const rawBacklights = typeof raw.backlights === 'object' && raw.backlights !== null ?
        raw.backlights : {};
    for (const [name, config] of Object.entries(rawBacklights)) {
        if (typeof config !== 'object' || config === null)
            continue;

        const nextConfig = {...config};
        const alias = normalizeAlias(nextConfig.alias);
        if (alias)
            nextConfig.alias = alias;
        else
            delete nextConfig.alias;
        normalized.backlights[name] = nextConfig;
    }

    return normalized;
}

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function applyRangeUpdate(existing, min, max) {
    const current = typeof existing === 'object' && existing !== null ? existing : {};
    const nextMin = min ?? current.min ?? 0;
    const nextAutoMax = current.autoMax ?? nextMin + 1;
    const nextMax = max ?? current.max ?? nextAutoMax;
    return {
        ...current,
        min: Math.min(nextMin, nextMax - 1),
        max: Math.max(nextMax, nextMin + 1),
    };
}

export function normalizeRange(existing, detectedMax = null) {
    const current = typeof existing === 'object' && existing !== null ? existing : {};
    const min = Number.isInteger(current.min) ? current.min : 0;
    const autoMax = Number.isInteger(current.autoMax) ? current.autoMax :
        (Number.isInteger(detectedMax) ? detectedMax : 1);
    const candidateMax = Number.isInteger(current.max) ? current.max : autoMax;
    const max = Math.max(candidateMax, min + 1);
    return {min, max, autoMax};
}

export function effectiveOrder(names, configuredOrder) {
    const seen = new Set();
    const ordered = [];
    for (const name of sanitizeNameList(configuredOrder)) {
        if (!names.includes(name) || seen.has(name))
            continue;
        seen.add(name);
        ordered.push(name);
    }

    const rest = names
        .filter(name => !seen.has(name))
        .sort((a, b) => a.localeCompare(b));

    return [...ordered, ...rest];
}

export function sortDevicesByOrder(devices, configuredOrder) {
    const indexByName = new Map(sanitizeNameList(configuredOrder)
        .map((name, index) => [name, index]));
    return devices.slice().sort((a, b) => {
        const aIndex = indexByName.get(a.name);
        const bIndex = indexByName.get(b.name);
        const aRank = aIndex === undefined ? Number.MAX_SAFE_INTEGER : aIndex;
        const bRank = bIndex === undefined ? Number.MAX_SAFE_INTEGER : bIndex;
        if (aRank !== bRank)
            return aRank - bRank;
        return a.name.localeCompare(b.name);
    });
}
