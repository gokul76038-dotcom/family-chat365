/* Family Chat - private 2-person chat, files, voice & video calls */
var CONFIG_OK = window.FIREBASE_CONFIG && JSON.stringify(window.FIREBASE_CONFIG).indexOf('PASTE_HERE') === -1;
if (CONFIG_OK) { firebase.initializeApp(window.FIREBASE_CONFIG); }
var auth = CONFIG_OK ? firebase.auth() : null;
var db = CONFIG_OK ? firebase.firestore() : null;
var storage = CONFIG_OK ? firebase.storage() : null;

var $ = function (id) { return document.getElementById(id); };
var me = null, myName = '', myAbout = '', myColor = '', peer = null, chatId = null;
var unsubMsgs = null, unsubUsers = null, unsubIncoming = null;
var pc = null, localStream = null, remoteStream = null, callId = null, unsubCall = [];
var incomingId = null, gotAnswer = false;

function show(id) {
  ['authScreen', 'listScreen', 'chatScreen', 'profileScreen'].forEach(function (s) {
    $(s).classList.toggle('active', s === id);
  });
}
function initial(n) { return (n || '?').trim().charAt(0).toUpperCase(); }
function fmtTime(ts) {
  var d = new Date(ts || Date.now());
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function setAvatar(el, name, color) {
  el.textContent = initial(name);
  el.style.background = color || '';
}
function friendlyError(e) {
  var m = {
    'auth/invalid-credential': 'Incorrect email or password',
    'auth/wrong-password': 'Incorrect password',
    'auth/user-not-found': 'No account found with this email',
    'auth/invalid-email': 'Please enter a valid email address',
    'auth/email-already-in-use': 'An account with this email already exists. Please log in',
    'auth/weak-password': 'Password must be at least 6 characters',
    'auth/network-request-failed': 'No internet connection. Please check and try again',
    'auth/too-many-requests': 'Too many attempts. Please try again later',
    'auth/operation-not-allowed': 'Email/Password sign-in is not enabled in Firebase',
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Firebase API key is invalid. Please check firebase-config.js'
  };
  return m[e.code] || ('Error: ' + (e.message || e));
}

/* ---------- AUTH ---------- */
function showView(v) {
  ['loginView', 'signupView', 'forgotView'].forEach(function (x) {
    $(x).classList.toggle('hidden', x !== v);
  });
  ['liErr', 'suErr', 'fgMsg'].forEach(function (x) { $(x).textContent = ''; });
  $('fgMsg').style.color = '';
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function notConfigured(el) {
  if (CONFIG_OK) return false;
  el.textContent = 'App is not configured yet (Firebase settings missing)';
  return true;
}
$('goSignup').onclick = function () { showView('signupView'); };
$('goForgot').onclick = function () { $('fgEmail').value = $('liEmail').value; showView('forgotView'); };
$('goLogin1').onclick = function () { showView('loginView'); };
$('goLogin2').onclick = function () { showView('loginView'); };
$('liEye').onclick = function () {
  var f = $('liPw');
  f.type = f.type === 'password' ? 'text' : 'password';
};

$('btnLogin').onclick = function () {
  var email = $('liEmail').value.trim(), pw = $('liPw').value;
  $('liErr').textContent = '';
  if (notConfigured($('liErr'))) return;
  if (!validEmail(email)) { $('liErr').textContent = 'Please enter a valid email address'; return; }
  if (!pw) { $('liErr').textContent = 'Please enter your password'; return; }
  auth.signInWithEmailAndPassword(email, pw).catch(function (e) {
    $('liErr').textContent = friendlyError(e);
  });
};

$('btnSignup').onclick = function () {
  var name = $('suName').value.trim(), email = $('suEmail').value.trim();
  var pw = $('suPw').value, pw2 = $('suPw2').value;
  $('suErr').textContent = '';
  if (notConfigured($('suErr'))) return;
  if (!name) { $('suErr').textContent = 'Please enter your name'; return; }
  if (!validEmail(email)) { $('suErr').textContent = 'Please enter a valid email address'; return; }
  if (pw.length < 6) { $('suErr').textContent = 'Password must be at least 6 characters'; return; }
  if (pw !== pw2) { $('suErr').textContent = 'Passwords do not match'; return; }
  auth.createUserWithEmailAndPassword(email, pw).then(function (cred) {
    myName = name;
    return db.collection('users').doc(cred.user.uid).set({
      uid: cred.user.uid, email: email.toLowerCase(), name: name,
      about: 'Hey there! I am using Family Chat', color: '', ts: Date.now()
    });
  }).catch(function (e) { $('suErr').textContent = friendlyError(e); });
};

$('btnReset').onclick = function () {
  var email = $('fgEmail').value.trim();
  var box = $('fgMsg');
  box.style.color = '';
  box.textContent = '';
  if (notConfigured(box)) return;
  if (!validEmail(email)) { box.textContent = 'Please enter a valid email address'; return; }
  auth.sendPasswordResetEmail(email).then(function () {
    box.style.color = '#2e7d32';
    box.textContent = 'Reset link sent to ' + email + '. Please check your inbox and spam folder.';
  }).catch(function (e) { box.style.color = ''; box.textContent = friendlyError(e); });
};

function doLogout() { if (auth) auth.signOut(); }
$('btnProfileLogout').onclick = doLogout;

if (CONFIG_OK) auth.onAuthStateChanged(function (user) {
  if (user) {
    me = user;
    db.collection('users').doc(user.uid).get().then(function (s) {
      var d = s.exists ? s.data() : {};
      myName = d.name || myName || user.email.split('@')[0];
      myAbout = d.about || '';
      myColor = d.color || '';
    }).catch(function () { myName = myName || user.email.split('@')[0]; });
    show('listScreen');
    loadContacts();
    listenIncoming();
  } else {
    me = null; peer = null; myName = ''; myAbout = ''; myColor = '';
    cleanupAll();
    showView('loginView');
    $('liPw').value = '';
    show('authScreen');
  }
});

function cleanupAll() {
  if (unsubMsgs) { unsubMsgs(); unsubMsgs = null; }
  if (unsubUsers) { unsubUsers(); unsubUsers = null; }
  if (unsubIncoming) { unsubIncoming(); unsubIncoming = null; }
  endCall(false);
  hideIncoming();
}

/* ---------- PROFILE & SETTINGS ---------- */
var COLORS = ['', '#e53935', '#8e24aa', '#3949ab', '#00897b', '#f4511e', '#6d4c41'];
var selColor = '';
function getPref(k, d) {
  try { var v = localStorage.getItem('fc_' + k); return v === null ? d : v; } catch (e) { return d; }
}
function setPref(k, v) { try { localStorage.setItem('fc_' + k, v); } catch (e) {} }
function applyPrefs() {
  document.documentElement.style.setProperty('--fs', getPref('size', '16') + 'px');
  document.documentElement.style.setProperty('--wall', getPref('wall', '#efeae2'));
}
applyPrefs();
$('prefSize').onchange = function () { setPref('size', $('prefSize').value); applyPrefs(); };
$('prefWall').onchange = function () { setPref('wall', $('prefWall').value); applyPrefs(); };

function buildSwatches() {
  var box = $('swatches');
  box.innerHTML = '';
  COLORS.forEach(function (c) {
    var s = document.createElement('button');
    s.type = 'button';
    s.className = 'sw' + (c === selColor ? ' sel' : '');
    s.style.background = c || 'linear-gradient(135deg,#ffd54f,#ff8a65)';
    s.onclick = function () {
      selColor = c;
      setAvatar($('profAvatar'), $('profName').value || myName, c);
      buildSwatches();
    };
    box.appendChild(s);
  });
}
$('profName').addEventListener('input', function () {
  setAvatar($('profAvatar'), $('profName').value || myName, selColor);
});

$('btnProfile').onclick = function () {
  $('profName').value = myName;
  $('profAbout').value = myAbout;
  $('profEmail').value = me.email;
  selColor = myColor;
  setAvatar($('profAvatar'), myName, selColor);
  buildSwatches();
  $('prefSize').value = getPref('size', '16');
  $('prefWall').value = getPref('wall', '#efeae2');
  $('profMsg').textContent = '';
  $('pwMsg').textContent = '';
  show('profileScreen');
};
$('btnProfileBack').onclick = function () { show('listScreen'); };

$('btnProfileSave').onclick = function () {
  var n = $('profName').value.trim(), ab = $('profAbout').value.trim();
  $('profMsg').style.color = '#d32f2f';
  if (!n) { $('profMsg').textContent = 'Name cannot be empty'; return; }
  db.collection('users').doc(me.uid).set({
    uid: me.uid, email: me.email.toLowerCase(), name: n, about: ab, color: selColor
  }, { merge: true }).then(function () {
    myName = n; myAbout = ab; myColor = selColor;
    $('profMsg').style.color = '#2e7d32';
    $('profMsg').textContent = 'Profile saved';
  }).catch(function (e) { $('profMsg').textContent = 'Error: ' + e.message; });
};

$('btnChangePw').onclick = function () {
  $('pwMsg').style.color = '#d32f2f';
  auth.sendPasswordResetEmail(me.email).then(function () {
    $('pwMsg').style.color = '#2e7d32';
    $('pwMsg').textContent = 'A link to change your password was sent to ' + me.email;
  }).catch(function (e) { $('pwMsg').textContent = friendlyError(e); });
};

/* ---------- CONTACTS ---------- */
function loadContacts() {
  if (unsubUsers) unsubUsers();
  unsubUsers = db.collection('users').onSnapshot(function (snap) {
    var box = $('contacts');
    box.innerHTML = '';
    var count = 0;
    snap.forEach(function (doc) {
      var u = doc.data();
      if (!me || u.uid === me.uid) return;
      count++;
      var row = document.createElement('div');
      row.className = 'contact';
      var av = document.createElement('div'); av.className = 'avatar'; setAvatar(av, u.name, u.color);
      var info = document.createElement('div');
      var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = u.name;
      var sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = u.about || u.email || '';
      info.appendChild(nm); info.appendChild(sub);
      row.appendChild(av); row.appendChild(info);
      row.onclick = function () { openChat(u); };
      box.appendChild(row);
    });
    $('noContacts').classList.toggle('hidden', count > 0);
  }, function (e) { $('noContacts').textContent = 'Error: ' + e.message; });
}

/* ---------- CHAT ---------- */
function openChat(u) {
  peer = u;
  chatId = [me.uid, u.uid].sort().join('_');
  $('chatName').textContent = u.name;
  setAvatar($('chatAvatar'), u.name, u.color);
  $('msgs').innerHTML = '';
  show('chatScreen');
  if (unsubMsgs) unsubMsgs();
  unsubMsgs = db.collection('chats').doc(chatId).collection('messages').orderBy('ts')
    .onSnapshot(renderMessages, function (e) { alert('Error: ' + e.message); });
}
$('btnBack').onclick = function () {
  if (unsubMsgs) { unsubMsgs(); unsubMsgs = null; }
  show('listScreen');
};

function renderMessages(snap) {
  var box = $('msgs');
  box.innerHTML = '';
  snap.forEach(function (doc) {
    var m = doc.data();
    var b = document.createElement('div');
    b.className = 'b ' + (m.from === me.uid ? 'me' : 'them');
    if (m.type === 'file') {
      if (m.mime && m.mime.indexOf('image/') === 0) {
        var img = document.createElement('img'); img.src = m.url; img.loading = 'lazy';
        b.appendChild(img);
      }
      var a = document.createElement('a');
      a.className = 'fl'; a.href = m.url; a.target = '_blank'; a.rel = 'noopener';
      var ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = '📄';
      var wrap = document.createElement('span');
      var fn = document.createElement('div'); fn.className = 'fn'; fn.textContent = m.name;
      var fs = document.createElement('div'); fs.className = 'fs'; fs.textContent = fmtSize(m.size);
      wrap.appendChild(fn); wrap.appendChild(fs);
      a.appendChild(ic); a.appendChild(wrap);
      b.appendChild(a);
    } else {
      var t = document.createElement('span'); t.textContent = m.text; b.appendChild(t);
    }
    var tm = document.createElement('span'); tm.className = 'tm'; tm.textContent = fmtTime(m.ts);
    b.appendChild(tm);
    box.appendChild(b);
  });
  box.scrollTop = box.scrollHeight;
}

function sendText() {
  var t = $('txt').value.trim();
  if (!t || !chatId) return;
  $('txt').value = '';
  db.collection('chats').doc(chatId).collection('messages').add({
    from: me.uid, type: 'text', text: t, ts: Date.now()
  }).catch(function (e) { alert('Send error: ' + e.message); });
}
$('btnSend').onclick = sendText;
$('txt').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendText(); });

$('btnAttach').onclick = function () { $('file').click(); };
$('file').onchange = function () {
  var f = $('file').files[0];
  $('file').value = '';
  if (!f || !chatId) return;
  var safe = f.name.replace(/[^\w.\-]+/g, '_');
  var ref = storage.ref('chats/' + chatId + '/' + Date.now() + '_' + safe);
  var box = $('upl');
  box.classList.remove('hidden');
  box.textContent = 'Upload: 0%';
  var task = ref.put(f, { contentType: f.type || 'application/octet-stream' });
  task.on('state_changed', function (s) {
    box.textContent = 'Upload: ' + Math.round(100 * s.bytesTransferred / s.totalBytes) + '%';
  }, function (e) {
    box.textContent = 'Upload failed: ' + e.message;
    setTimeout(function () { box.classList.add('hidden'); }, 5000);
  }, function () {
    task.snapshot.ref.getDownloadURL().then(function (url) {
      return db.collection('chats').doc(chatId).collection('messages').add({
        from: me.uid, type: 'file', url: url, name: f.name, size: f.size, mime: f.type || '', ts: Date.now()
      });
    }).then(function () { box.classList.add('hidden'); })
      .catch(function (e) { box.textContent = 'Error: ' + e.message; });
  });
};

/* ---------- CALLS (WebRTC, signaling via Firestore) ---------- */
function setStatus(t) { $('callStatus').textContent = t; }

function getMedia(video) {
  return navigator.mediaDevices.getUserMedia({
    audio: true, video: video ? { facingMode: 'user' } : false
  });
}

function setupPc(video) {
  pc = new RTCPeerConnection({ iceServers: window.ICE_SERVERS });
  remoteStream = new MediaStream();
  $('remoteVideo').srcObject = remoteStream;
  localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
  pc.ontrack = function (e) {
    e.streams[0].getTracks().forEach(function (t) { remoteStream.addTrack(t); });
  };
  pc.onconnectionstatechange = function () {
    if (!pc) return;
    if (pc.connectionState === 'connected') setStatus('Connected');
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') endCall(true);
  };
  $('localVideo').srcObject = localStream;
  $('localVideo').style.display = video ? 'block' : 'none';
  $('btnCam').style.display = video ? '' : 'none';
  $('btnMute').classList.remove('off'); $('btnCam').classList.remove('off');
}

function showCallUI(name, status) {
  $('callName').textContent = name;
  setAvatar($('callAvatar'), name, '');
  setStatus(status);
  $('callScreen').classList.remove('hidden');
}

function watchCall(ref, candidateCollection) {
  unsubCall.push(ref.onSnapshot(function (s) {
    var d = s.data();
    if (!d || !pc) return;
    if (d.answer && !gotAnswer && d.from === me.uid) {
      gotAnswer = true;
      pc.setRemoteDescription(new RTCSessionDescription(d.answer)).catch(function () {});
    }
    if (d.status === 'ended') endCall(false);
  }));
  unsubCall.push(ref.collection(candidateCollection).onSnapshot(function (s) {
    s.docChanges().forEach(function (c) {
      if (c.type === 'added' && pc) {
        pc.addIceCandidate(new RTCIceCandidate(c.doc.data())).catch(function () {});
      }
    });
  }));
}

function startCall(video) {
  if (pc || !peer) return;
  getMedia(video).then(function (stream) {
    localStream = stream;
    setupPc(video);
    gotAnswer = false;
    var ref = db.collection('calls').doc();
    callId = ref.id;
    pc.onicecandidate = function (e) {
      if (e.candidate) ref.collection('callerCandidates').add(e.candidate.toJSON());
    };
    showCallUI(peer.name, 'Calling...');
    return pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer).then(function () {
        return ref.set({
          from: me.uid, fromName: myName, to: peer.uid, video: !!video, status: 'ringing',
          ts: Date.now(), offer: { type: offer.type, sdp: offer.sdp }
        });
      });
    }).then(function () { watchCall(ref, 'calleeCandidates'); });
  }).catch(function (e) {
    endCall(false);
    alert('Please allow Microphone/Camera access (Settings > Apps > Family Chat > Permissions). ' + (e.message || ''));
  });
}
$('btnVoice').onclick = function () { startCall(false); };
$('btnVideo').onclick = function () { startCall(true); };

function listenIncoming() {
  if (unsubIncoming) unsubIncoming();
  unsubIncoming = db.collection('calls').where('to', '==', me.uid).where('status', '==', 'ringing')
    .onSnapshot(function (snap) {
      snap.docChanges().forEach(function (ch) {
        var d = ch.doc.data();
        if (ch.type === 'added' && !pc && !incomingId && Date.now() - d.ts < 60000) {
          incomingId = ch.doc.id;
          $('inName').textContent = d.fromName || 'Family';
          $('inAvatar').textContent = initial(d.fromName);
          $('inType').textContent = d.video ? 'Video call...' : 'Voice call...';
          $('incoming').classList.remove('hidden');
          if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
        }
        if (ch.type === 'removed' && ch.doc.id === incomingId) hideIncoming();
      });
    }, function () {});
}
function hideIncoming() { incomingId = null; $('incoming').classList.add('hidden'); }

$('btnDecline').onclick = function () {
  var id = incomingId;
  hideIncoming();
  if (id) db.collection('calls').doc(id).update({ status: 'ended' }).catch(function () {});
};

$('btnAccept').onclick = function () {
  var id = incomingId;
  if (!id || pc) return;
  var ref = db.collection('calls').doc(id);
  ref.get().then(function (snap) {
    var d = snap.data();
    hideIncoming();
    if (!d || d.status !== 'ringing') return;
    return getMedia(d.video).then(function (stream) {
      localStream = stream;
      setupPc(d.video);
      gotAnswer = true;
      callId = id;
      pc.onicecandidate = function (e) {
        if (e.candidate) ref.collection('calleeCandidates').add(e.candidate.toJSON());
      };
      showCallUI(d.fromName || 'Family', 'Connecting...');
      return pc.setRemoteDescription(new RTCSessionDescription(d.offer)).then(function () {
        return pc.createAnswer();
      }).then(function (ans) {
        return pc.setLocalDescription(ans).then(function () {
          return ref.update({ answer: { type: ans.type, sdp: ans.sdp }, status: 'active' });
        });
      }).then(function () { watchCall(ref, 'callerCandidates'); });
    });
  }).catch(function (e) {
    endCall(true);
    alert('Call error: ' + (e.message || e));
  });
};

function endCall(notify) {
  var id = callId;
  unsubCall.forEach(function (u) { u(); });
  unsubCall = [];
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
  remoteStream = null; callId = null; gotAnswer = false;
  $('remoteVideo').srcObject = null;
  $('localVideo').srcObject = null;
  $('callScreen').classList.add('hidden');
  if (notify && id) db.collection('calls').doc(id).update({ status: 'ended' }).catch(function () {});
}
$('btnHang').onclick = function () { endCall(true); };

$('btnMute').onclick = function () {
  if (!localStream) return;
  var off = !$('btnMute').classList.contains('off');
  localStream.getAudioTracks().forEach(function (t) { t.enabled = !off; });
  $('btnMute').classList.toggle('off', off);
  $('btnMute').textContent = off ? '🔇' : '🎤';
};
$('btnCam').onclick = function () {
  if (!localStream) return;
  var off = !$('btnCam').classList.contains('off');
  localStream.getVideoTracks().forEach(function (t) { t.enabled = !off; });
  $('btnCam').classList.toggle('off', off);
};
