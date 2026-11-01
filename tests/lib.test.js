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
