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

  // Countries that use each currency (ISO 4217 code: ISO 3166 regions, two
  // letters each), from the datasets/country-codes table. Lets the picker
  // find a currency by country: "Thailand" finds THB.
  const REGIONS = (
    'AED:AE AFN:AF ALL:AL AMD:AM AOA:AO ARS:AR AUD:AUCCCXHMKINFNRTV AWG:AW AZN:AZ BAM:BA BBD:BB ' +
    'BDT:BD BHD:BH BIF:BI BMD:BM BND:BN BOB:BO BRL:BR BSD:BS BTN:BT BWP:BW BYN:BY BZD:BZ CAD:CA ' +
    'CDF:CD CHF:CHLI CLP:CL CNY:CN COP:CO CRC:CR CUP:CU CVE:CV CZK:CZ DJF:DJ DKK:DKFOGL DOP:DO DZD:DZ ' +
    'EGP:EG ERN:ER ETB:ET ' +
    'EUR:ADATAXBEBGBLCYDEEEESFIFRGFGPGRHRIEITLTLULVMCMEMFMQMTNLPMPTRESISKSMTFVAYT FJD:FJ FKP:FK ' +
    'GBP:GBGGIMJE GEL:GE GHS:GH GIP:GI GMD:GM GNF:GN GTQ:GT GYD:GY HKD:HK HNL:HN HTG:HT HUF:HU IDR:ID ' +
    'ILS:IL INR:BTIN IQD:IQ IRR:IR ISK:IS JMD:JM JOD:JO JPY:JP KES:KE KGS:KG KHR:KH KMF:KM KPW:KP ' +
    'KRW:KR KWD:KW KYD:KY KZT:KZ LAK:LA LBP:LB LKR:LK LRD:LR LSL:LS LYD:LY MAD:EHMA MDL:MD MGA:MG ' +
    'MKD:MK MMK:MM MNT:MN MOP:MO MRU:MR MUR:MU MVR:MV MWK:MW MXN:MX MYR:MY MZN:MZ NAD:NA NGN:NG ' +
    'NIO:NI NOK:BVNOSJ NPR:NP NZD:CKNUNZPNTK OMR:OM PAB:PA PEN:PE PGK:PG PHP:PH PKR:PK PLN:PL PYG:PY ' +
    'QAR:QA RON:RO RSD:RS RUB:RU RWF:RW SAR:SA SBD:SB SCR:SC SDG:SD SEK:SE SGD:SG SHP:SH SLE:SL ' +
    'SOS:SO SRD:SR SSP:SS STN:ST SVC:SV SYP:SY SZL:SZ THB:TH TJS:TJ TMT:TM TND:TN TOP:TO TRY:TR ' +
    'TTD:TT TWD:TW TZS:TZ UAH:UA UGX:UG USD:ASBQECFMGUHTIOMHMPPAPRPWSVTCTLUMUSVGVI UYU:UY UZS:UZ ' +
    'VED:VE VES:VE VND:VN VUV:VU WST:WS XAF:CFCGCMGAGQTD XCD:AGAIDMGDKNLCMSVC XCG:CWSX ' +
    'XOF:BFBJCIGWMLNESNTG XPF:NCPFWF YER:YE ZAR:LSNAZA ZMW:ZM ZWG:ZW'
  );
  const regionTable = {};
  for (const part of REGIONS.split(' ')) {
    const [code, regs] = part.split(':');
    regionTable[code] = regs.match(/../g);
  }
  const regionsOf = code => regionTable[code] || [];

  // Everyday names people type that aren't the official country name.
  const REGION_ALIASES = {
    GB: ['UK', 'Britain', 'England', 'Scotland', 'Wales'],
    US: ['USA', 'America'],
    AE: ['UAE', 'Dubai', 'Abu Dhabi'],
    NL: ['Holland'],
    ID: ['Bali'],
    CZ: ['Czech Republic'],
  };

  // How well a search matches a currency: lower is better, null is no match.
  // `places` are country names for the currency; a country match carries
  // the name as a hint, unless the currency's own name already says it.
  function searchScore(query, code, name, places) {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const c = code.toLowerCase(), n = name.toLowerCase();
    const wordStart = text => text.toLowerCase().split(/[\s-]+/).some(w => w.startsWith(q));
    const hintFor = place => (n.includes(place.toLowerCase()) ? undefined : place);
    if (c === q) return { score: 0 };
    if (c.startsWith(q)) return { score: 1 };
    for (const place of places) if (place.toLowerCase() === q) return { score: 1.5, hint: hintFor(place) };
    if (n.startsWith(q)) return { score: 2 };
    for (const place of places) if (place.toLowerCase().startsWith(q)) return { score: 2.5, hint: hintFor(place) };
    if (wordStart(name)) return { score: 3 };
    for (const place of places) if (wordStart(place)) return { score: 3.5, hint: hintFor(place) };
    // Countries only match from the start of a word: "yen" shouldn't find Jan Mayen.
    if (n.includes(q)) return { score: 4 };
    return null;
  }

  const lib = { CRYPTO, fractionDigits, amountOpts, parseNumber, evaluate, mergeRates, regionsOf, REGION_ALIASES, searchScore };
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.BureauLib = lib;
})(this);
