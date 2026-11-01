// Bureau's pure logic: number parsing, sums, formatting options and rate
// merging. No DOM and no app state, so the same file runs in the page and
// under `node --test tests/` in CI.
(function (root) {
  const CRYPTO = { BTC: 'Bitcoin', ETH: 'Ether', SOL: 'Solana' };

  function fractionDigits(code) {
    if (CRYPTO[code]) return 8;
    try { return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits; }
    catch { return 2; }
  }

  // Currency's own decimals; only amounts that would round to zero get significant digits.
  function amountOpts(n, code) {
    const abs = Math.abs(n);
    if (CRYPTO[code]) return abs >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 6 } : { maximumSignificantDigits: 6 };
    const d = fractionDigits(code);
    if (abs > 0 && abs < Math.pow(10, -d) * 5) return { maximumSignificantDigits: 3 };
    return { minimumFractionDigits: d, maximumFractionDigits: d };
  }

  // One number as typed: either "." or "," can be the decimal point. When both
  // appear the last one is; a lone separator is grouping only when it's the
  // locale's group mark followed by exactly three digits ("1.500" in Germany).
  function parseNumber(s, group) {
    s = s.replace(/['’]/g, '');
    if (!s) return NaN;
    const hasDot = s.includes('.'), hasComma = s.includes(',');
    if (hasDot && hasComma) {
      const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
      s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
    } else if (hasDot || hasComma) {
      const ch = hasDot ? '.' : ',';
      const parts = s.split(ch);
      if (parts.length > 2) s = parts.join('');
      else if (ch === group && parts[1].length === 3 && parts[0].length > 0) s = parts.join('');
      else s = (parts[0] || '0') + '.' + parts[1];
    }
    return /^\d*\.?\d+$|^\d+\.$/.test(s) ? parseFloat(s) : NaN;
  }

  // Amount fields accept simple sums such as 12*3.5 or (40+25)/2. Hand-parsed; nothing is eval'd.
  function evaluate(text, group) {
    const src = String(text).replace(/[\s  ]/g, '').replace(/[×xX]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-');
    if (!src) return { value: NaN, isExpr: false };
    const tokens = src.match(/[0-9.,'’]+|[-+*/()]/g);
    if (!tokens || tokens.join('') !== src) return { value: NaN, isExpr: false };
    let i = 0;
    const peek = () => tokens[i];
    function factor() {
      const t = tokens[i++];
      if (t === '-') return -factor();
      if (t === '+') return factor();
      if (t === '(') { const v = expr(); if (tokens[i++] !== ')') return NaN; return v; }
      return t === undefined ? NaN : parseNumber(t, group);
    }
    function term() {
      let v = factor();
      while (peek() === '*' || peek() === '/') { const op = tokens[i++]; const r = factor(); v = op === '*' ? v * r : v / r; }
      return v;
    }
    function expr() {
      let v = term();
      while (peek() === '+' || peek() === '-') { const op = tokens[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
      return v;
    }
    const value = expr();
    const isExpr = tokens.length > 1;
    return { value: i === tokens.length && Number.isFinite(value) ? value : NaN, isExpr };
  }

  // Coinbase's live rate wins unless it's more than 10% away from the daily
  // reference: its quotes for thinly traded currencies (and tickers that clash
  // with old currency codes) can be far off. Rates are units per 1 USD.
  function mergeRates(live, ref, isFiat) {
    const out = {};
    if (ref) for (const [k, v] of Object.entries(ref)) if (isFiat(k) && v > 0) out[k] = v;
    if (live) {
      for (const [k, v] of Object.entries(live)) {
        if (CRYPTO[k]) { out[k] = v; continue; }
        if (!isFiat(k)) continue;
        if (ref && ref[k] > 0 && Math.abs(v / ref[k] - 1) > 0.1) continue;
        out[k] = v;
      }
    }
    return out;
  }

  const lib = { CRYPTO, fractionDigits, amountOpts, parseNumber, evaluate, mergeRates };
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.BureauLib = lib;
})(this);
