// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { fractionDigits, amountOpts, parseNumber, evaluate, mergeRates } = require('../web/lib.js');

test('parseNumber reads either separator as the decimal point', () => {
  // English-style locale (group ",")
  assert.equal(parseNumber('12,50', ','), 12.5);
  assert.equal(parseNumber('1,234.5', ','), 1234.5);
  assert.equal(parseNumber('1,234', ','), 1234);
  assert.equal(parseNumber('1.500', ','), 1.5);
  // German-style locale (group ".")
  assert.equal(parseNumber('1.5', '.'), 1.5);
  assert.equal(parseNumber('1.500', '.'), 1500);
  assert.equal(parseNumber('1.234,5', '.'), 1234.5);
  // Swiss grouping, edge shapes, junk
  assert.equal(parseNumber("1'000", "'"), 1000);
  assert.equal(parseNumber('5.', ','), 5);
  assert.equal(parseNumber('.5', ','), 0.5);
  assert.equal(parseNumber('1.2.3', ','), 123);
  assert.ok(Number.isNaN(parseNumber('', ',')));
  assert.ok(Number.isNaN(parseNumber('abc', ',')));
});

test('evaluate handles sums without eval', () => {
  assert.deepEqual(evaluate('100', ','), { value: 100, isExpr: false });
  assert.deepEqual(evaluate('12*3.5', ','), { value: 42, isExpr: true });
  assert.equal(evaluate('12×3', ',').value, 36);
  assert.equal(evaluate('(40+25)/2', ',').value, 32.5);
  assert.equal(evaluate('10 − 2.5', ',').value, 7.5);
  assert.equal(evaluate('1 234,5 + 0,5', ' ').value, 1235);
  assert.equal(evaluate('-5', ',').value, -5);
  assert.ok(Number.isNaN(evaluate('2+', ',').value));
  assert.ok(Number.isNaN(evaluate('(2+3', ',').value));
  assert.ok(Number.isNaN(evaluate('1/0', ',').value));
  assert.ok(Number.isNaN(evaluate('alert(1)', ',').value));
});

test('mergeRates keeps live quotes unless they stray from the daily reference', () => {
  const fiat = new Set(['USD', 'EUR', 'GBP', 'ERN']);
  const isFiat = c => fiat.has(c);
  const live = { USD: 1, EUR: 0.9, ERN: 165.5, BTC: 0.00001, ESP: 120 };
  const ref = { USD: 1, EUR: 0.88, GBP: 0.75, ERN: 15 };
  const out = mergeRates(live, ref, isFiat);
  assert.equal(out.EUR, 0.9);    // within 10%: live wins
  assert.equal(out.ERN, 15);     // 10x off: reference wins
  assert.equal(out.GBP, 0.75);   // only in the reference
  assert.equal(out.BTC, 0.00001);
  assert.equal(out.ESP, undefined); // not a current currency
  assert.deepEqual(mergeRates(null, ref, isFiat), { USD: 1, EUR: 0.88, GBP: 0.75, ERN: 15 });
});

test('formatting follows each currency\'s decimals', () => {
  assert.equal(fractionDigits('USD'), 2);
  assert.equal(fractionDigits('JPY'), 0);
  assert.equal(fractionDigits('BTC'), 8);
  assert.deepEqual(amountOpts(5, 'JPY'), { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  assert.deepEqual(amountOpts(0.47, 'GBP'), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.deepEqual(amountOpts(0.004, 'USD'), { maximumSignificantDigits: 3 });
  assert.deepEqual(amountOpts(0.0012, 'BTC'), { maximumSignificantDigits: 6 });
});

test('trend sampling covers the range and ends yesterday', () => {
  const { sampleDates, crossSeries } = require('../web/lib.js');
  const now = new Date('2026-11-02T09:00:00Z');
  const week = sampleDates(7, now);
  assert.equal(week.length, 8);
  assert.equal(week[0], '2026-10-25');
  assert.equal(week.at(-1), '2026-11-01');
  const month = sampleDates(30, now);
  assert.equal(month.length, 16);
  assert.equal(month[0], '2026-10-02');
  const year = sampleDates(365, now);
  assert.equal(year.at(-1), '2026-11-01');
  assert.ok(year.length >= 26 && year.length <= 28);
  assert.deepEqual([...year].sort(), year);

  const snaps = [{ usd: { eur: 0.9, btc: 0.00001 } }, null, { usd: { eur: 0.8 } }];
  assert.deepEqual(crossSeries(['d1', 'd2', 'd3'], snaps, 'BTC', 'EUR'), [['d1', 90000]]);
  assert.deepEqual(crossSeries(['d1', 'd2', 'd3'], snaps, 'USD', 'EUR'), [['d1', 0.9], ['d3', 0.8]]);
});

test('currencies can be found by country', () => {
  const { regionsOf, searchScore, REGION_ALIASES } = require('../web/lib.js');
  assert.deepEqual(regionsOf('JPY'), ['JP']);
  assert.ok(regionsOf('EUR').includes('DE') && regionsOf('EUR').includes('FR'));
  assert.ok(regionsOf('USD').includes('US') && regionsOf('USD').includes('EC'));
  assert.deepEqual(regionsOf('BTC'), []);
  assert.ok(REGION_ALIASES.GB.includes('UK'));

  // code beats name beats country; a country match names the country
  assert.equal(searchScore('thb', 'THB', 'Thai Baht', ['Thailand']).score, 0);
  assert.equal(searchScore('th', 'THB', 'Thai Baht', ['Thailand']).score, 1);
  assert.deepEqual(searchScore('thail', 'THB', 'Thai Baht', ['Thailand']), { score: 2.5, hint: 'Thailand' });
  // exact country match; no hint because the currency's name already says it
  assert.deepEqual(searchScore('vietnam', 'VND', 'Vietnamese Dong', ['Vietnam']), { score: 1.5, hint: undefined });
  assert.deepEqual(searchScore('mexico', 'MXN', 'Mexican Peso', ['Mexico']), { score: 1.5, hint: 'Mexico' });
  assert.deepEqual(searchScore('mexi', 'MXN', 'Mexican Peso', ['Mexico']), { score: 2 });
  assert.deepEqual(searchScore('germany', 'EUR', 'Euro', ['Germany', 'France']), { score: 1.5, hint: 'Germany' });
  assert.deepEqual(searchScore('fra', 'EUR', 'Euro', ['Germany', 'France']), { score: 2.5, hint: 'France' });
  assert.equal(searchScore('dollar', 'AUD', 'Australian Dollar', ['Australia']).score, 3);
  assert.deepEqual(searchScore('zealand', 'NZD', 'New Zealand Dollar', ['New Zealand']), { score: 3 });
  // an exact country or alias beats a currency name that merely starts the same
  assert.ok(searchScore('uk', 'GBP', 'British Pound', ['United Kingdom', 'UK']).score
    < searchScore('uk', 'UAH', 'Ukrainian Hryvnia', ['Ukraine']).score);
  // country names match from word starts only
  assert.equal(searchScore('yen', 'NOK', 'Norwegian Krone', ['Norway', 'Svalbard & Jan Mayen']), null);
  assert.equal(searchScore('xyz', 'JPY', 'Japanese Yen', ['Japan']), null);
  assert.equal(searchScore('  ', 'JPY', 'Japanese Yen', ['Japan']), null);
});
