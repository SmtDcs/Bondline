// Checks one recorded receipt bundle in the visitor's browser with WebCrypto:
//   1. sha256(response bytes) == the response hash inside the signed text
//   2. the ed25519 signature over the signed text verifies against the key stored in the bundle
// It never shows a result it did not compute.

const root = document.querySelector<HTMLElement>('[data-verify]');
if (root) {
  const b = JSON.parse(root.dataset.bundle!) as {
    model: string; responseB64: string; requestHash: string; responseHash: string;
    signedText: string; signatureHex: string; publicKeyHex: string;
  };
  const $ = (k: string) => root.querySelector<HTMLElement>(`[data-v="${k}"]`)!;
  const hex = (u: Uint8Array) => [...u].map((x) => x.toString(16).padStart(2, '0')).join('');
  const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((x) => parseInt(x, 16)));
  const enc = new TextEncoder(), dec = new TextDecoder();
  const original = Uint8Array.from(atob(b.responseB64), (c) => c.charCodeAt(0));

  let edited = false, forged = false;

  const short = (h: string) => `${h.slice(0, 16)}…${h.slice(-8)}`;
  function setRow(k: string, state: 'ok' | 'bad' | 'na', label: string) {
    const row = $(k);
    row.dataset.state = state;
    row.querySelector('.v-res')!.textContent = label;
  }

  async function run() {
    const bytes = edited ? enc.encode(dec.decode(original).replace('bps=2000', 'bps=3000')) : original;
    const content = JSON.parse(dec.decode(bytes)).choices[0].message.content as string;
    const lines = content.split('\n');
    $('reply').textContent = lines.slice(0, -1).join('\n').trim();
    $('token').textContent = lines[lines.length - 1];
    $('token').classList.toggle('is-edited', edited);

    let digest: string;
    try {
      digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    } catch {
      return unsupported();
    }
    // "Forge the hash": the shop rewrites the signed text so that it names the edited bytes.
    const signedText = forged ? `${b.model}:${b.requestHash}:${digest}` : b.signedText;
    const claimed = signedText.split(':')[2];
    $('computed').textContent = short(digest);
    $('claimed').textContent = short(claimed);
    $('signed').textContent = `${b.model}:${short(b.requestHash)}:${short(claimed)}`;
    const hashOk = digest === claimed;
    setRow('row-hash', hashOk ? 'ok' : 'bad', hashOk ? 'MATCH' : 'MISMATCH');

    let sigOk: boolean;
    try {
      const key = await crypto.subtle.importKey('raw', unhex(b.publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
      sigOk = await crypto.subtle.verify({ name: 'Ed25519' }, key, unhex(b.signatureHex), enc.encode(signedText));
    } catch {
      return unsupported();
    }
    setRow('row-sig', sigOk ? 'ok' : 'bad', sigOk ? 'VALID' : 'INVALID');

    const verdict = $('verdict');
    const ok = hashOk && sigOk;
    verdict.dataset.state = ok ? 'ok' : 'bad';
    verdict.querySelector('.v-res')!.textContent = ok ? 'SELF-CONSISTENT' : 'NOT VERIFIED';
    $('explain').textContent = ok
      ? 'These are the bytes the key signed. Checked in this browser just now.'
      : !hashOk
        ? 'One character changed, so the bytes no longer hash to the value that was signed. On chain the same edit has no receipt: ERR_NO_RECEIPT_FOR_BYTES.'
        : 'The signed text now names the edited bytes, but the signature was made over the original text. On chain the shop\'s attempt to register an edited reply failed the same way: ERR_BAD_SIGNATURE.';
    root!.dataset.ran = '1';
  }

  function unsupported() {
    setRow('row-hash', 'na', 'RECORDED');
    setRow('row-sig', 'na', 'RECORDED');
    const verdict = $('verdict');
    verdict.dataset.state = 'na';
    verdict.querySelector('.v-res')!.textContent = 'NOT CHECKED HERE';
    $('explain').textContent = 'This browser has no WebCrypto Ed25519, so nothing was checked here. The values shown are the recorded ones; npm run verify:fixtures runs the same check locally.';
    root!.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((x) => (x.disabled = true));
  }

  const btn = (k: string) => root.querySelector<HTMLButtonElement>(`[data-act="${k}"]`)!;
  function sync() {
    btn('edit').setAttribute('aria-pressed', String(edited));
    btn('forge').setAttribute('aria-pressed', String(forged));
    btn('forge').disabled = !edited;
    btn('reset').disabled = !edited && !forged;
  }
  btn('edit').addEventListener('click', () => { edited = !edited; if (!edited) forged = false; sync(); run(); });
  btn('forge').addEventListener('click', () => { forged = !forged; sync(); run(); });
  btn('reset').addEventListener('click', () => { edited = false; forged = false; sync(); run(); });

  root.classList.add('is-live');
  sync();
  // run when the section first comes near the screen
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); run(); } }, { rootMargin: '200px' });
  io.observe(root);
}
