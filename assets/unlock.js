'use strict';
/* 我的课表 · 静态加密版解锁逻辑
 * 页面里只有密文；密码经 PBKDF2-SHA256(600,000) 派生 AES-256-GCM 密钥，解开后把课表放进同源 iframe。
 * 浏览器里和 Node（测试）里都能用：无 document 时只导出 crypto API。
 */
(function (global) {
  var ITERATIONS = 600000;
  var STORAGE_KEY = 'tt.unlock.key.v1';
  var LOCK_MESSAGE = 'tt-lock';

  function bytesToB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBytes(text) {
    var bin = atob(text);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function assertPayload(payload) {
    if (!payload || payload.v !== 1 || typeof payload.salt !== 'string' || typeof payload.iv !== 'string' ||
        typeof payload.ct !== 'string' || !Number.isInteger(payload.iter) || payload.iter < 10000) {
      throw new Error('payload-invalid');
    }
  }
  function subtleCrypto() {
    var subtle = global.crypto && global.crypto.subtle;
    if (!subtle) throw new Error('crypto-unavailable');
    return subtle;
  }
  async function deriveRawKey(password, saltB64, iterations) {
    var subtle = subtleCrypto();
    var base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    var bits = await subtle.deriveBits({ name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations: iterations, hash: 'SHA-256' }, base, 256);
    return new Uint8Array(bits);
  }
  async function decryptWithPassword(password, payload) {
    assertPayload(payload);
    var raw = await deriveRawKey(password, payload.salt, payload.iter);
    var key = await subtleCrypto().importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    var plain = await subtleCrypto().decrypt({ name: 'AES-GCM', iv: b64ToBytes(payload.iv) }, key, b64ToBytes(payload.ct));
    return { html: new TextDecoder().decode(plain), key: bytesToB64(raw) };
  }
  async function decryptWithKey(keyB64, payload) {
    assertPayload(payload);
    var raw = b64ToBytes(keyB64);
    if (raw.length !== 32) throw new Error('key-invalid');
    var key = await subtleCrypto().importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    var plain = await subtleCrypto().decrypt({ name: 'AES-GCM', iv: b64ToBytes(payload.iv) }, key, b64ToBytes(payload.ct));
    return new TextDecoder().decode(plain);
  }

  var api = {
    ITERATIONS: ITERATIONS,
    STORAGE_KEY: STORAGE_KEY,
    bytesToB64: bytesToB64,
    b64ToBytes: b64ToBytes,
    deriveRawKey: deriveRawKey,
    decryptWithPassword: decryptWithPassword,
    decryptWithKey: decryptWithKey
  };
  global.TTUnlock = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') initPage();

  function initPage() {
    var $ = function (id) { return document.getElementById(id); };
    var form = $('unlock-form');
    var input = $('password');
    var messageBox = $('form-message');
    var submit = $('submit');
    var submitLabel = $('submit-label');
    var reveal = $('reveal');
    var frame = null;
    var busy = false;
    var reduced = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false, addEventListener: function () {} };
    var paused = reduced.matches;

    if (!form || !input || !messageBox || !submit) return;

    function setState(name) { document.documentElement.dataset.state = name; }
    function message(text, isError) {
      messageBox.textContent = text || '';
      messageBox.classList.toggle('error', !!isError);
    }
    function setBusy(value) {
      busy = value;
      submit.disabled = value;
      input.readOnly = value;
      form.setAttribute('aria-busy', String(value));
      submitLabel.textContent = value ? '正在解锁…' : '进入我的课表';
    }
    function sessionGet() { try { return global.sessionStorage.getItem(STORAGE_KEY); } catch (e) { return null; } }
    function sessionSet(value) { try { global.sessionStorage.setItem(STORAGE_KEY, value); } catch (e) { /* 隐私模式：本次会话仍可用 */ } }
    function sessionClear() { try { global.sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ } }

    function showApp(html) {
      if (frame) { frame.remove(); frame = null; }
      frame = document.createElement('iframe');
      frame.id = 'app-frame';
      frame.title = '我的课表';
      frame.srcdoc = html;
      document.body.appendChild(frame);
      document.body.classList.add('unlocked');
      setState('unlocked');
      try { frame.focus(); } catch (e) { /* ignore */ }
    }
    function hideApp() {
      if (frame) { frame.remove(); frame = null; }
      document.body.classList.remove('unlocked');
      setState('locked');
      input.value = '';
      message('');
      setBusy(false);
      try { input.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    async function unlock(password) {
      var payload = global.__TT_LOCK;
      var result = await decryptWithPassword(password, payload);
      sessionSet(result.key);
      showApp(result.html);
      return true;
    }
    function lock() {
      sessionClear();
      hideApp();
    }
    global.TTUnlockPage = { unlock: unlock, lock: lock, hideApp: hideApp, isUnlocked: function () { return !!frame; } };

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (busy) return;
      if (!input.value) { message('请先输入密码。', true); input.focus(); return; }
      message('');
      setBusy(true);
      try {
        await unlock(input.value);
        input.value = '';
        message('');
      } catch (error) {
        var name = error && error.name;
        if (name === 'OperationError' || /decrypt/i.test(String(error && error.message))) message('密码不对，请再试一次。', true);
        else if (error && error.message === 'crypto-unavailable') message('当前浏览器不支持解密，请换用较新的浏览器。', true);
        else if (error && error.message === 'payload-invalid') message('页面数据不完整，请刷新后重试。', true);
        else message('暂时无法解锁，请刷新后重试。', true);
        input.value = '';
        input.focus();
      } finally {
        setBusy(false);
      }
    });

    reveal.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      reveal.textContent = show ? '隐藏' : '显示';
      reveal.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      reveal.setAttribute('aria-pressed', String(show));
    });
    input.addEventListener('input', function () { input.removeAttribute('aria-invalid'); });

    global.addEventListener('message', function (event) {
      if (event.origin !== global.location.origin) return;
      if (event.data === LOCK_MESSAGE) lock();
    });

    // 同一标签页刷新时沿用会话里的派生密钥；关掉标签页就要重新输入。
    var stored = sessionGet();
    if (stored && global.__TT_LOCK) {
      setBusy(true);
      message('正在恢复上一次的解锁…');
      decryptWithKey(stored, global.__TT_LOCK).then(function (html) {
        showApp(html);
        message('');
      }).catch(function () {
        sessionClear();
        message('');
      }).finally(function () {
        setBusy(false);
      });
    }

    // 动效开关与轻微视差（与登录页同一套）
    function paintMotion() {
      document.body.classList.toggle('paused', paused);
      var motion = $('motion');
      if (!motion) return;
      motion.setAttribute('aria-pressed', String(paused));
      $('motion-label').textContent = paused ? '动效已暂停' : '暂停动效';
      var icon = document.querySelector('.motion-icon');
      if (icon) icon.textContent = paused ? '▷' : 'Ⅱ';
      if (reduced.matches) { motion.disabled = true; $('motion-label').textContent = '已减少动态效果'; }
      else motion.disabled = false;
    }
    var motion = $('motion');
    if (motion) motion.addEventListener('click', function () { paused = !paused; paintMotion(); });
    if (reduced.addEventListener) reduced.addEventListener('change', function () { paused = reduced.matches; paintMotion(); });
    paintMotion();
    var frameId = 0;
    document.addEventListener('pointermove', function (event) {
      if (paused || reduced.matches || event.pointerType !== 'mouse' || innerWidth < 701 || frameId) return;
      frameId = requestAnimationFrame(function () {
        document.documentElement.style.setProperty('--px', ((event.clientX / innerWidth) - 0.5) * 12 + 'px');
        document.documentElement.style.setProperty('--py', ((event.clientY / innerHeight) - 0.5) * 8 + 'px');
        frameId = 0;
      });
    }, { passive: true });
  }
})(typeof window !== 'undefined' ? window : globalThis);
