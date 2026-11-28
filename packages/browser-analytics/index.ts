// Browser-only transport. No SDK, background queue, cookie, DOM inspection or daemon dependency.
const events: Record<'manager' | 'site', Record<string, readonly string[]>> = {
  site: {page_view: ['home','releases','terms','privacy'], download_clicked: ['macos','windows','linux','other'], install_command_copied: ['shell']},
  manager: {manager_opened:['manager'], view_opened:['servers','people','analytics','settings'], feature_used:['server_added','server_started','server_stopped','server_restarted','agent_connected']},
};
type Choice = 'granted' | 'denied';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createAnalytics(scope: keyof typeof events, config: {key?:string; host?:string}) {
  const choiceKey = `hypergate.analytics.${scope}.v1.choice`;
  const idKey = `hypergate.analytics.${scope}.v1.id`;
  function available(): boolean {
    try {
      const nav = navigator as Navigator & {globalPrivacyControl?:boolean; msDoNotTrack?:string};
      if (nav.globalPrivacyControl || [nav.doNotTrack, nav.msDoNotTrack, (window as Window & {doNotTrack?:string}).doNotTrack].some(v => v === '1' || v === 'yes')) {
        // A privacy signal is a withdrawal: drop a saved grant and its ID so reporting can't resume later.
        if (window.localStorage.getItem(choiceKey) === 'granted') { window.localStorage.removeItem(idKey); window.localStorage.setItem(choiceKey, 'denied'); }
        return false;
      }
      return !!config.key?.match(/^phc_[a-zA-Z0-9]+$/) && ['https://us.i.posthog.com','https://eu.i.posthog.com'].includes(config.host ?? '') && !!window.crypto?.randomUUID && window.localStorage.getItem(choiceKey) !== undefined;
    } catch { return false; }
  }
  function consent(): Choice | 'unset' {
    try { const v = window.localStorage.getItem(choiceKey); return v === 'granted' || v === 'denied' ? v : 'unset'; } catch { return 'unset'; }
  }
  function setConsent(choice: Choice) {
    try {
      if (choice === 'denied') { window.localStorage.removeItem(idKey); window.localStorage.setItem(choiceKey, choice); }
      else if (choice === 'granted' && available()) { if (!uuid.test(window.localStorage.getItem(idKey) ?? '')) window.localStorage.setItem(idKey, window.crypto.randomUUID()); window.localStorage.setItem(choiceKey, choice); }
    } catch { /* Blocked storage: never fall back to an in-memory tracking ID. */ }
  }
  function track(event:string, value:string) {
    try {
      if (!Object.hasOwn(events[scope], event) || !events[scope][event].includes(value) || !available() || consent() !== 'granted') return;
      const distinct_id = window.localStorage.getItem(idKey);
      if (!distinct_id || !uuid.test(distinct_id)) return;
      const body = JSON.stringify({api_key:config.key, event:`hypergate_${scope}_${event}`, properties:{distinct_id, product:'hypergate', surface:scope, value, $process_person_profile:false, $geoip_disable:true}});
      void fetch(`${config.host}/i/v0/e/`, {method:'POST', body, headers:{'Content-Type':'text/plain;charset=UTF-8'}, credentials:'omit', referrerPolicy:'no-referrer', redirect:'error', keepalive:true}).catch(() => {});
    } catch { /* Offline/unsupported collection must never affect the product action. */ }
  }
  return {available, consent, setConsent, track};
}
