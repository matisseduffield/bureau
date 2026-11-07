// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { fractionDigits, amountOpts, parseNumber, evaluate } = require('../web/lib.js');

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

const isFiat = c => /^[A-Z]{3}$/.test(c) && !['BTC', 'ETH', 'XRP', 'BNB', 'SOL', 'ADA', 'LTC'].includes(c);
const coinFile = { date: '2026-11-06', usd: { usd: 1, eur: 0.9, gbp: 0.75, syp: 13004, btc: 0.00001, eth: 0.0004, usdt: 1.001, xrp: 0.8, bnb: 0.0014, sol: 0.011, usdc: 1, doge: 14, ada: 5.4, ltc: 0.019, shib: 90000 } };
const erAnswer = { result: 'success', time_last_update_unix: 1793923351, rates: { USD: 1, EUR: 0.88, GBP: 0.74, SYP: 121, BTC: 5, CLF: 0.02 } };

test('the daily answer gives currencies and its own publish time', () => {
  const { dailyRates } = require('../web/lib.js');
  const out = dailyRates(erAnswer, c => isFiat(c) && c !== 'CLF');
  assert.equal(out.updatedAt, 1793923351000);
  assert.deepEqual(out.fiat, { USD: 1, EUR: 0.88, GBP: 0.74, SYP: 121 });
  assert.equal(dailyRates({ result: 'error' }, isFiat), null);
  assert.equal(dailyRates({ ...erAnswer, time_last_update_unix: undefined }, isFiat), null);
  assert.equal(dailyRates(null, isFiat), null);
});

test('the daily file splits into coins and currencies, dated by the file', () => {
  const { fileRates, CRYPTO } = require('../web/lib.js');
  const out = fileRates(coinFile, isFiat);
  assert.equal(out.updatedAt, Date.UTC(2026, 10, 6));
  assert.deepEqual(Object.keys(out.coins).sort(), Object.keys(CRYPTO).sort());
  assert.equal(out.coins.BTC, 0.00001);
  assert.equal(out.fiat.EUR, 0.9);
  assert.equal(out.fiat.USD, 1);
  assert.equal(out.fiat.SYP, undefined);   // the file's figure is far out
  assert.equal(out.coins.SHIB, undefined); // not one of the ten
  assert.equal(out.fiat.BTC, undefined);
  assert.equal(fileRates({ date: 'soon', usd: coinFile.usd }, isFiat), null);
  assert.equal(fileRates({ date: '2026-11-06', usd: { btc: 1 } }, isFiat), null);
  assert.equal(fileRates(null, isFiat), null);
});

test('a refresh never passes old or missing rates off as current', () => {
  const { dailyRates, fileRates, combineRates } = require('../web/lib.js');
  const daily = dailyRates(erAnswer, isFiat), file = fileRates(coinFile, isFiat);
  const blank = { fiat: null, coins: null, fiatAt: 0, coinAt: 0 };

  // Normal: currencies from the daily source, coins from the file.
  let out = combineRates(blank, daily, file);
  assert.equal(out.fiat.EUR, 0.88);
  assert.equal(out.coins.BTC, 0.00001);
  assert.equal(out.fiatAt, daily.updatedAt);
  assert.equal(out.coinAt, file.updatedAt);
  assert.equal(out.complete, true);
  assert.equal(out.offline, false);

  // Daily source down: the file stands in, with the file's date.
  out = combineRates(blank, null, file);
  assert.equal(out.fiat.EUR, 0.9);
  assert.equal(out.fiatAt, file.updatedAt);
  assert.equal(out.complete, false);

  // A coin the new file lacks goes, even though we had one saved.
  const saved = { fiat: { USD: 1, EUR: 0.8 }, coins: { BTC: 0.00002, SOL: 0.02 }, fiatAt: 1000, coinAt: 1000 };
  const noSol = fileRates({ ...coinFile, usd: { ...coinFile.usd, sol: undefined } }, isFiat);
  out = combineRates(saved, daily, noSol);
  assert.equal(out.coins.SOL, undefined);
  assert.equal(out.coins.BTC, 0.00001);

  // File down: saved coins keep their old date, currencies move on.
  out = combineRates(saved, daily, null);
  assert.equal(out.coins.BTC, 0.00002);
  assert.equal(out.coinAt, 1000);
  assert.equal(out.fiatAt, daily.updatedAt);
  assert.equal(out.complete, false);

  // Both down: nothing changes and it says so.
  out = combineRates(saved, null, null);
  assert.equal(out.offline, true);
  assert.equal(out.fiatAt, 1000);

  // A file older than what we hold doesn't replace it.
  const newer = { ...saved, fiatAt: file.updatedAt + 1, coinAt: file.updatedAt + 1 };
  out = combineRates(newer, null, file);
  assert.equal(out.fiat.EUR, 0.8);
  assert.equal(out.coins.BTC, 0.00002);
  assert.equal(out.coinAt, file.updatedAt + 1);
});

test('a pair is dated by its older side', () => {
  const { pairUpdatedAt } = require('../web/lib.js');
  assert.equal(pairUpdatedAt('EUR', 'GBP', 200, 100), 200);
  assert.equal(pairUpdatedAt('BTC', 'EUR', 200, 100), 100);
  assert.equal(pairUpdatedAt('EUR', 'BTC', 100, 200), 100);
  assert.equal(pairUpdatedAt('USD', 'BTC', 200, 100), 100);
  assert.equal(pairUpdatedAt('USD', 'EUR', 200, 100), 200);
});

test('formatting follows each currency\'s decimals', () => {
  assert.equal(fractionDigits('USD'), 2);
  assert.equal(fractionDigits('JPY'), 0);
  assert.equal(fractionDigits('BTC'), 8);
  assert.deepEqual(amountOpts(5, 'JPY'), { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  assert.deepEqual(amountOpts(0.47, 'GBP'), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.deepEqual(amountOpts(0.004, 'USD'), { maximumSignificantDigits: 3 });
  assert.deepEqual(amountOpts(0.0012, 'BTC'), { maximumSignificantDigits: 6 });
  // coins show about a cent's worth of decimals
  const { cryptoDigits } = require('../web/lib.js');
  assert.equal(cryptoDigits(1), 2);        // USDT
  assert.equal(cryptoDigits(0.075), 2);    // DOGE
  assert.equal(cryptoDigits(94), 4);       // SOL
  assert.equal(cryptoDigits(2268), 6);     // ETH
  assert.equal(cryptoDigits(77930), 7);    // BTC
  assert.equal(cryptoDigits(undefined), 6);
  assert.deepEqual(amountOpts(327.487641, 'USDT', 1), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
