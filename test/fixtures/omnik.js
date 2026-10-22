// -----------------------------------------------------------------------------
// Answers of an Omnik Wi-Fi logger: the fixtures of the omnikinverter library
// (tests/fixtures, MIT, already anonymized there, see THIRD_PARTY_NOTICES.md)
// and a page generator for the app tests.
// -----------------------------------------------------------------------------

export const ADDRESS = '192.168.1.70';
export const SERIAL = 'NLDN2020123456';
/** The logger's id (html `cover_mid`, tcp logger serial): only a fingerprint may be kept. */
export const LOGGER_ID = '602123456';
/** 2026-10-21 12:00 in Paris (10:00 UTC). */
export const NOW = Date.parse('2026-10-21T10:00:00Z');

const round = (v) => Math.round(Number(v) * 1000) / 1000;

/**
 * A `js` answer (default) or an `html` one. `count` 0: the logger answers
 * without its inverter (the night). `energy`: kWh (number or text).
 */
export function page({
  serial = SERIAL,
  power = 226,
  energy = 0.89,
  total = 6454.5,
  count = 1,
  model = 'omnik3000tl',
  source = 'js',
  registry = LOGGER_ID,
} = {}) {
  if (source === 'html') {
    const v =
      count > 0
        ? { sn: serial, now: String(power), today: String(round(energy)), total: String(total) }
        : { sn: '', now: '', today: '', total: '' };
    return [
      `var webdata_sn = "${v.sn}";`,
      'var webdata_msvn = "V5.07Build245";',
      'var webdata_ssvn = "";',
      `var webdata_pv_type = "${count > 0 ? model : ''}";`,
      'var webdata_rate_p = "3000";',
      `var webdata_now_p = "${v.now}";`,
      `var webdata_today_e = "${v.today}";`,
      `var webdata_total_e = "${v.total}";`,
      'var webdata_alarm = "";',
      'var webdata_utime = "1";',
      `var cover_mid = "${registry}";`,
      'var cover_ver = "ME_08_0102_2.03";',
      'var cover_sta_rssi = "80%";',
      'var cover_sta_ip = "192.168.1.70";',
    ].join('');
  }
  const data =
    count > 0
      ? `${serial},V5.07Build245,V4.12Build246,${model},3000,${power},${Math.round(Number(energy) * 100)},${Math.round(total * 10)},,1,`
      : ',,,,,,,,,0,';
  return `var version="H4.01.38Y1.0.09W1.0.08";var m2mRssi="96%";var wanIp="192.168.1.70";var webData="${data}";`;
}

/** The fixtures of the library, as the loggers send them. */
export const LIBRARY = {
  statusHtml:
    'var webdata_sn = "12345678910";var webdata_msvn = "V5.07Build245";var webdata_ssvn = "";var webdata_pv_type = "Omnik2500tl ";var webdata_rate_p = "2500";var webdata_now_p = "219";var webdata_today_e = "0.23";var webdata_total_e = "6454.5";var webdata_alarm = "F13";var webdata_utime = "1";var cover_mid = "902000501";var cover_ver = "ME_08_0102_2.03";var cover_wmode = "";var cover_ap_ssid = "";var cover_ap_ip = "";var cover_ap_mac = "F0FE6B79BA5B";var cover_sta_ssid = "";var cover_sta_rssi = "";var cover_sta_ip = "192.168.0.106";var cover_sta_mac = "F0FE6B79BA5A";var status_a = "1";var status_b = "0";var status_c = "0";\n',
  statusSolisHtml: [
    'var webdata_sn = "1234567890ABCDE ";',
    'var webdata_msvn = "001F";',
    'var webdata_ssvn = "002F";',
    'var webdata_pv_type = "0079";',
    'var webdata_rate_p = "";',
    'var webdata_now_p = "5850";',
    'var webdata_today_e = "9.80";',
    'var webdata_total_e = "44.0";',
    'var webdata_alarm = "";',
    'var webdata_utime = "0";',
    'var cover_mid = "1234567890";',
    'var cover_ver = "MW_08_512_0501_1.82";',
    'var cover_sta_rssi = "96%";',
    '',
  ].join('\n'),
  statusJson: JSON.stringify({
    g_ver: 'VER:ME-111001-V1.0.6(2015-10-16)',
    ip: '192.168.0.10',
    i_sn: '',
    i_ver_m: 'V1.25Build23261',
    i_ver_s: 'V1.40Build52927',
    i_modle: 'omnik2000tl2',
    i_pow: '2000',
    i_pow_n: 1225,
    i_eday: '10.90',
    i_eall: '8674.0',
    i_alarm: 'F23',
    i_last_t: 0,
  }),
  wrongStatusJson: JSON.stringify({
    g_ver: 'VER:ME-111001-V1.0.6(2015-10-16)',
    ip: '192.168.0.10',
    i_sn: '',
    i_modle: 'omnik2000tl2',
    i_pow: '',
    i_pow_n: 1225,
    i_eday: '0.0',
    i_eall: '0.0',
  }),
  devicearrayJs:
    'var version= "H4.01.51MW.2.01W1.0.64(2018-01-251-D)";var m2mRssi= "39%";var wanIp= "";var myDeviceArray=new Array();myDeviceArray[0]="12345678910,V4.08Build215,V4.12Build246,Omnik1500tl ,,850,232,52002,,1,";\n',
  sofarJs:
    'var version= "H4.01.51MW.2.01W1.0.64(2018-01-251-D)";var m2mRssi= "39%";var wanIp= "";var myDeviceArray=new Array();myDeviceArray[0]="1234567890  ,V450,,SOFAR2200TL,2 000,400,567,123070,,1,";\n',
  webdataJs:
    'var version="H4.01.38Y1.0.09W1.0.08";var m2mRssi="96%";var wanIp="192.168.0.10";var webData="12345678910,NL2-V9.8-5931,V5.3-00157,omnik4000tl2,4000,140,30,153637,F13,0,";\n',
  wrongHtml: "Lol it's empty!\n",
  tcpReply:
    '687d41b0b168de3ab168de3a8102014e4c444e30313233343543533433323101af07510761ffff0051004effff006cffffffff095cffffffff138e0a37ffffffffffffffff02e40009fbf10000d431000100000000ffff000000000000000000004e4c312d56312e302d303037372d34000000000056322e302d303032340000000000000000000000ae16',
  tcpReplyNoFirmware:
    '685541b03590ea233590ea238102014e4c444e32303230313332313230333500ea049f0000ffff00000097ffff0001ffffffff08c5ffffffff138a0000ffffffffffffffff02d10001f66b000078dc000100000000ffff00000000000000000000f216',
  tcpReplyOffline:
    '68a941b0c8fcde5fc8fcde5f8102014e4c424e343032303135375039303234ff2e00000000000000000000000000000000000000000000000000000000000000000000000001d6000269e4000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001f16',
};

/** Hex -> bytes. */
export const bytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));

/** A text answer of the logger. */
export const text = (body, { status = 200, headers = {} } = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
