import {
    applyRangeUpdate,
    createInitialConfig,
    effectiveOrder,
    normalizeAlias,
    normalizeConfig,
    normalizeRange,
    sortDevicesByOrder,
} from '../logic.js';

const failures = [];

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function assertDeepEqual(actual, expected, message) {
    if (!deepEqual(actual, expected))
        throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
}

function test(name, fn) {
    try {
        fn();
        print(`PASS ${name}`);
    } catch (error) {
        failures.push({name, error});
        print(`FAIL ${name}: ${error.message}`);
    }
}

test('normalizeAlias trims strings and handles non-strings', () => {
    assertDeepEqual(normalizeAlias('  panel  '), 'panel', 'trimmed alias should be returned');
    assertDeepEqual(normalizeAlias('   '), '', 'blank alias should normalize to empty');
    assertDeepEqual(normalizeAlias(null), '', 'null alias should normalize to empty');
});

test('createInitialConfig returns expected shape', () => {
    assertDeepEqual(
        createInitialConfig(),
        {version: 1, backlights: {}, settings: {order: [], hidden: []}},
        'initial config shape should stay stable'
    );
});

test('normalizeConfig sanitizes settings and aliases', () => {
    const input = {
        version: 'x',
        backlights: {
            intel: {alias: '  Laptop  ', min: 2},
            nvidia: {alias: '   '},
            broken: 42,
        },
        settings: {
            order: ['intel', 123, 'nvidia'],
            hidden: [null, 'intel'],
        },
    };
    assertDeepEqual(
        normalizeConfig(input),
        {
            version: 1,
            backlights: {
                intel: {alias: 'Laptop', min: 2},
                nvidia: {},
            },
            settings: {
                order: ['intel', 'nvidia'],
                hidden: ['intel'],
            },
        },
        'config normalization should clean invalid values'
    );
});

test('applyRangeUpdate keeps max > min and preserves existing keys', () => {
    const updated = applyRangeUpdate({min: 50, max: 60, autoMax: 100, alias: 'panel'}, 80, null);
    assertDeepEqual(
        updated,
        {min: 59, max: 81, autoMax: 100, alias: 'panel'},
        'range update should clamp min below max'
    );
});

test('normalizeRange fills in missing values and clamps max', () => {
    assertDeepEqual(
        normalizeRange({min: 20, max: 10}, 100),
        {min: 20, max: 21, autoMax: 100},
        'range should clamp max to min + 1 and use detected max as autoMax'
    );
    assertDeepEqual(
        normalizeRange({}, null),
        {min: 0, max: 1, autoMax: 1},
        'empty range should have safe defaults'
    );
});

test('effectiveOrder preserves configured order and appends sorted rest', () => {
    const result = effectiveOrder(
        ['intel', 'amdgpu', 'acpi_video0'],
        ['amdgpu', 'missing', 'amdgpu']
    );
    assertDeepEqual(
        result,
        ['amdgpu', 'acpi_video0', 'intel'],
        'effective order should dedupe configured names and append remaining sorted names'
    );
});

test('sortDevicesByOrder sorts known devices by configured order', () => {
    const devices = [
        {name: 'intel'},
        {name: 'acpi_video0'},
        {name: 'amdgpu'},
    ];
    assertDeepEqual(
        sortDevicesByOrder(devices, ['amdgpu']),
        [{name: 'amdgpu'}, {name: 'acpi_video0'}, {name: 'intel'}],
        'device ordering should prefer configured names'
    );
});

if (failures.length > 0) {
    throw new Error(`${failures.length} test(s) failed`);
}

print('All logic tests passed.');
