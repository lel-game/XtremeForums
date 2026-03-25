const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null, currentProfile = null, viewStack = [], curState = { view: 'forum', threadId: null }, editingPostId = null;

function fakeEmail(u) { return u.toLowerCase().replace(/[^a-z0-9]/g,'') + '@xtremeforums.fake'; }

async function initAuth() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await loadProfile(session.user);
    sb.auth.onAuthStateChange(async (_e, session) => {
      if (session) await loadProfile(session.user);
      else { currentUser = null; currentProfile = null; updateAuthUI(); }
    });
  } catch (err) {
    console.error('Auth init error:', err);
  }
}

async function loadProfile(user) {
  currentUser = user;
  try {
    const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
    if (error && error.code !== 'PGRST116') throw error;
    currentProfile = data || null;
  } catch (err) {
    console.error('Profile load error:', err);
    currentProfile = null;
  }
  updateAuthUI();
}

function updateAuthUI() {
  const loggedIn = !!currentUser;
  document.getElementById('auth-btn').style.display = loggedIn ? 'none' : '';
  document.getElementById('logout-btn').style.display = loggedIn ? '' : 'none';
  const g = document.getElementById('user-greeting');
  if (loggedIn && currentProfile) {
    const img = currentProfile.avatar_url
      ? '<img src="' + esc(currentProfile.avatar_url) + '" style="width:18px;height:18px;object-fit:cover;border:1px solid #808080;">'
      : '&#128100;';
    g.innerHTML = img + ' ' + esc(currentProfile.username);
  } else if (loggedIn) {
    g.innerHTML = '&#128100; (profile missing)';
  } else {
    g.innerHTML = '';
  }
}

async function doLogin() {
  clearErr();
  const username = v('login-username'), pass = document.getElementById('login-pass').value;
  if (!username || !pass) { showErr('fill both fields dummy!!!'); return; }
  const { error } = await sb.auth.signInWithPassword({ email: fakeEmail(username), password: pass });
  if (error) { showErr('wrong username or password!!!'); return; }
  closeModal(); reloadView();
}

async function doRegister() {
  clearErr();
  const username = v('reg-username'), pass = document.getElementById('reg-pass').value, sig = v('reg-sig');
  const fileInput = document.getElementById('reg-avatar-file');
  if (!username || !pass) { showErr('fill in all da fields!!!'); return; }
  if (pass.length < 6) { showErr('password needs 2 b at least 6 chars!!!'); return; }
  if (!/^[a-zA-Z0-9_\-]+$/.test(username)) { showErr('username: only letters, numbers, _ and - !!!'); return; }
  const { data: ex } = await sb.from('profiles').select('id').eq('username', username).maybeSingle();
  if (ex) { showErr('username already taken!!!'); return; }
  const { data, error } = await sb.auth.signUp({ email: fakeEmail(username), password: pass });
  if (error) { showErr('register failed: ' + error.message); return; }
  let avatar_url = '';
  if (data.user && fileInput.files[0]) {
    const file = fileInput.files[0], ext = file.name.split('.').pop();
    const path = data.user.id + '/avatar.' + ext;
    const { error: upErr } = await sb.storage.from('avatars').upload(path, file, { upsert: true });
    if (!upErr) { const { data: ud } = sb.storage.from('avatars').getPublicUrl(path); avatar_url = ud.publicUrl; }
  }
  if (data.user) await sb.from('profiles').insert({ id: data.user.id, username, sig, avatar_url, post_count: 0 });
  closeModal(); reloadView();
}

async function doLogout() { await sb.auth.signOut(); reloadView(); }
function openModal() { document.getElementById('modal-bg').classList.add('show'); clearErr(); }
function closeModal() { document.getElementById('modal-bg').classList.remove('show'); }
function switchTab(t) {
  document.getElementById('login-form').style.display = t === 'login' ? '' : 'none';
  document.getElementById('register-form').style.display = t === 'register' ? '' : 'none';
  document.getElementById('tab-login').className = 'tab' + (t==='login' ? ' active' : '');
  document.getElementById('tab-register').className = 'tab' + (t==='register' ? ' active' : '');
  clearErr();
}
function showErr(m) { const e = document.getElementById('auth-error'); e.textContent = m; e.style.display = ''; }
function clearErr() { document.getElementById('auth-error').style.display = 'none'; }
function previewAvatar() {
  const file = document.getElementById('reg-avatar-file').files[0], prev = document.getElementById('avatar-preview');
  if (file) { prev.src = URL.createObjectURL(file); prev.style.display = 'block'; } else { prev.style.display = 'none'; }
}

function goBack() {
  if (viewStack.length > 1) {
    viewStack.pop();
    const p = viewStack[viewStack.length-1];
    navigate(p.view, p.data, false);
  }
}

function navigate(view, data={}, push=true) {
  curState = { view, ...data };
  editingPostId = null;
  if (push) viewStack.push({ view, data });
  if (view === 'forum') renderForum();
  else if (view === 'thread') renderThread(data.threadId);
  else if (view === 'newthread') renderNewThread(data.catId);
}

function reloadView() {
  if (curState.view === 'thread') renderThread(curState.threadId);
  else if (curState.view === 'newthread') renderNewThread(curState.catId);
  else renderForum();
}

async function renderForum() {
  const root = document.getElementById('app-root');
  root.innerHTML = '<div style="text-align:center;padding:16px;color:#000080">loading...</div>';
  try {
    const [{ data: cats }, { data: threads }, { data: allPosts }] = await Promise.all([
      sb.from('categories').select('*').order('id'),
      sb.from('threads').select('*, profiles(username, avatar_url)').order('pinned',{ascending:false}).order('created_at',{ascending:false}),
      sb.from('posts').select('thread_id'),
    ]);
    const cmap = {}; (allPosts||[]).forEach(p => { cmap[p.thread_id] = (cmap[p.thread_id]||0)+1; });
    const greeting = (currentUser && currentProfile) ? esc(currentProfile.username) : (currentUser ? 'Logged in' : 'Guest');
    const stats = '<div class="stats-bar"><span>&#128196; Threads: ' + (threads||[]).length + '</span><span>&#128172; Posts: ' + (allPosts||[]).length + '</span><span>&#128101; ' + (currentUser ? (currentProfile ? esc(currentProfile.username) : 'Logged in (profile missing)') : 'browsing as Guest') + ' - welcome back!!!</span></div>';
    const catsHtml = (cats||[]).map(cat => {
      const ts = (threads||[]).filter(t => t.category_id === cat.id);
      const rows = ts.length === 0
        ? '<tr><td colspan="5" style="color:#808080;font-style:italic;text-align:center">no threads yet... u go first!!!</td></tr>'
        : ts.map(t => {
            const av = t.profiles?.avatar_url ? '<img src="' + esc(t.profiles.avatar_url) + '" style="width:16px;height:16px;object-fit:cover;border:1px solid #808080;vertical-align:middle;margin-right:3px;">' : '';
            return '<tr class="clickable" onclick="navigate(\'thread\',{threadId:' + t.id + '})"><td>' + (t.pinned?'&#128204; ':'') + '<b>' + esc(t.title) + '</b></td><td>' + av + esc(t.profiles?.username||'???') + '</td><td>' + Math.max(0,(cmap[t.id]||1)-1) + '</td><td>' + (t.views||0) + '</td><td>' + fmt(t.created_at) + '</td></tr>';
          }).join('');
      return '<div class="win-outer" style="margin-bottom:8px"><div class="win-title"><span>' + esc(cat.icon||'') + ' ' + esc(cat.name) + '</span><span style="font-size:10px;color:#a0c0ff">' + esc(cat.description||'') + '</span></div><div style="margin:4px"><table><thead><tr><th>Thread</th><th>Author</th><th>Replies</th><th>Views</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table><div style="margin-top:5px;text-align:right">' + (currentUser ? '<button class="btn98 btn-primary" onclick="navigate(\'newthread\',{catId:' + cat.id + '})">+ New Thread</button>' : '<span style="font-size:10px;color:#808080">login 2 post!!!</span>') + '</div></div></div>';
    }).join('');
    root.innerHTML = stats + catsHtml;
  } catch (err) {
    console.error('renderForum error:', err);
    root.innerHTML = '<div class="error-box">Failed to load forum data.</div>';
  }
}

async function renderThread(threadId) {
  const root = document.getElementById('app-root');
  root.innerHTML = '<div style="text-align:center;padding:16px;color:#000080">loading thread...</div>';
  try {
    const [{ data: thread }, { data: posts }] = await Promise.all([
      sb.from('threads').select('*, categories(name,icon)').eq('id', threadId).single(),
      sb.from('posts').select('*, profiles(username, avatar_url, sig, post_count)').eq('thread_id', threadId).order('created_at'),
    ]);
    if (!thread) { root.innerHTML = '<div class="error-box">thread not found!!!</div>'; return; }

    // unique view tracking (assumes unique constraint on (thread_id, viewer_id))
    if (currentUser && currentUser.id !== thread.author_id) {
      const { error: ve } = await sb.from('thread_views').insert({ thread_id: threadId, viewer_id: currentUser.id });
      if (!ve) await sb.from('threads').update({ views: (thread.views||0)+1 }).eq('id', threadId);
    }

    const postsHtml = (posts||[]).map((post, i) => {
      const pf = post.profiles || {}, isOwn = currentUser && currentUser.id === post.author_id, isEditing = editingPostId === post.id;
      const avatarHtml = pf.avatar_url ? '<img src="' + esc(pf.avatar_url) + '" alt="av">' : '<div class="avatar-placeholder">&#128100;</div>';
      const edited = post.updated_at && post.updated_at !== post.created_at ? ' (edited)' : '';
      const actionBtns = isOwn && !isEditing ? '<div class="post-actions"><button class="btn98 btn-sm" onclick="startEdit(' + post.id + ')">Edit</button><button class="btn98 btn-sm btn-danger" onclick="deletePost(' + post.id + ',' + threadId + ',' + (i===0) + ')">Del</button></div>' : '';
      const bodyHtml = isEditing
        ? '<textarea class="edit-area" id="edit-ta-' + post.id + '">' + esc(post.content) + '</textarea><div style="display:flex;gap:5px"><button class="btn98 btn-primary btn-sm" onclick="saveEdit(' + post.id + ',' + threadId + ')">Save</button><button class="btn98 btn-sm" onclick="cancelEdit(' + threadId + ')">Cancel</button></div>'
        : '<div class="post-content">' + esc(post.content) + '</div>' + (pf.sig ? '<div class="post-sig">' + esc(pf.sig) + '</div>' : '');
      return '<div class="' + (i>0?'reply-indent':'') + '" style="margin-bottom:8px" id="post-' + post.id + '"><div class="post-card"><div class="post-head"><span class="uname">' + esc(pf.username||'???') + '</span><span class="meta">' + fmt(post.created_at) + edited + '</span>' + actionBtns + '</div><div class="post-inner"><div class="avatar-col">' + avatarHtml + '<div class="uname-small">' + esc(pf.username||'???') + '</div><span class="online-dot"></span><div class="post-count-label">' + (pf.post_count||0) + ' posts</div></div><div class="post-body-wrap">' + bodyHtml + '</div></div></div></div>';
    }).join('');

    const replyBox = currentUser
      ? '<div class="win-outer"><div class="win-title"><span>&#9997; Post a Reply</span></div><div style="margin:6px"><div style="margin-bottom:4px;font-size:11px">Posting as: <b>' + (currentProfile ? esc(currentProfile.username) : '???') + '</b></div><textarea id="reply-text" style="width:100%;height:90px" placeholder="type ur reply xD rawr!!!"></textarea><div style="margin-top:5px;display:flex;gap:6px"><button class="btn98 btn-primary" onclick="submitReply(' + threadId + ')">Post Reply!!!</button><button class="btn98" onclick="navigate(\'forum\')">Cancel</button></div><div id="reply-msg" style="margin-top:4px"></div></div></div>'
      : '<div class="notice">&#128274; <a href="#" onclick="openModal();return false" style="color:#000080;font-weight:bold">Login</a> 2 reply!!!</div>';

    root.innerHTML = '<div style="margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><button class="btn98" onclick="navigate(\'forum\')">&#8592; Back</button><span style="font-weight:bold;font-size:13px">' + esc(thread.title) + '</span></div>' + postsHtml + replyBox;
  } catch (err) {
    console.error('renderThread error:', err);
    root.innerHTML = '<div class="error-box">Failed to load thread.</div>';
  }
}

function startEdit(postId) { editingPostId = postId; renderThread(curState.threadId); }
function cancelEdit(threadId) { editingPostId = null; renderThread(threadId); }

async function saveEdit(postId, threadId) {
  const content = (document.getElementById('edit-ta-' + postId)?.value||'').trim();
  if (!content) { alert('cant save empty post dummy!!!'); return; }
  const { error } = await sb.from('posts').update({ content, updated_at: new Date().toISOString() }).eq('id', postId).eq('author_id', currentUser.id);
  if (error) { alert('save failed: ' + error.message); return; }
  editingPostId = null; renderThread(threadId);
}

async function deletePost(postId, threadId, isFirstPost) {
  if (isFirstPost) {
    if (!confirm('deleting the first post will delete the WHOLE thread!!! u sure???')) return;
    const { error } = await sb.from('threads').delete().eq('id', threadId).eq('author_id', currentUser.id);
    if (error) { alert('delete failed: ' + error.message); return; }
    navigate('forum');
  } else {
    if (!confirm('delete this post??? cant undo!!!')) return;
    const { error } = await sb.from('posts').delete().eq('id', postId).eq('author_id', currentUser.id);
    if (error) { alert('delete failed: ' + error.message); return; }
    const nc = Math.max(0,(currentProfile?.post_count||1)-1);
    await sb.from('profiles').update({ post_count: nc }).eq('id', currentUser.id);
    if (currentProfile) currentProfile.post_count = nc;
    renderThread(threadId);
  }
}

async function submitReply(threadId) {
  const txt = (document.getElementById('reply-text')?.value||'').trim(), msgEl = document.getElementById('reply-msg');
  if (!txt) { msgEl.innerHTML = '<span style="color:red">type something first dummy!!!</span>'; return; }
  if (!currentUser) { msgEl.innerHTML = '<span style="color:red">you must be logged in!!!</span>'; return; }
  const { error } = await sb.from('posts').insert({ thread_id: threadId, author_id: currentUser.id, content: txt });
  if (error) { msgEl.innerHTML = '<span style="color:red">error: ' + esc(error.message) + '</span>'; return; }
  const nc = (currentProfile?.post_count||0)+1;
  await sb.from('profiles').update({ post_count: nc }).eq('id', currentUser.id);
  if (currentProfile) currentProfile.post_count = nc;
  renderThread(threadId);
}

async function renderNewThread(catId) {
  const root = document.getElementById('app-root');
  let catName = 'unknown category', catIcon = '';
  try {
    const { data: cat } = await sb.from('categories').select('*').eq('id', catId).single();
    if (cat) { catName = cat.name; catIcon = cat.icon; }
  } catch (err) { console.warn('Category not found', err); }
  root.innerHTML = '<div style="margin-bottom:6px"><button class="btn98" onclick="navigate(\'forum\')">&#8592; Back</button><span style="margin-left:8px;font-weight:bold">New Thread in: ' + esc(catIcon||'') + ' ' + esc(catName) + '</span></div><div class="win-outer"><div class="win-title"><span>&#9997; Create New Thread</span></div><div style="margin:8px"><div style="margin-bottom:8px"><label>Thread Title:</label><input type="text" id="new-title" placeholder="type ur gr8 thread title here!!!" maxlength="200"></div><div style="margin-bottom:8px"><label>First Post:</label><textarea id="new-content" style="width:100%;height:110px" placeholder="say something!!1! rawr"></textarea></div><div style="display:flex;gap:6px"><button class="btn98 btn-primary" onclick="submitThread(' + catId + ')">Post Thread!!!</button><button class="btn98" onclick="navigate(\'forum\')">Cancel</button></div><div id="newthread-msg" style="margin-top:4px"></div></div></div>';
}

async function submitThread(catId) {
  const title = (document.getElementById('new-title')?.value||'').trim(), content = (document.getElementById('new-content')?.value||'').trim(), msgEl = document.getElementById('newthread-msg');
  if (!title||!content) { msgEl.innerHTML = '<span style="color:red">fill in all da fields!!!</span>'; return; }
  const { data: thread, error: te } = await sb.from('threads').insert({ title, category_id: catId, author_id: currentUser.id, views: 0, pinned: false }).select().single();
  if (te) { msgEl.innerHTML = '<span style="color:red">error: ' + esc(te.message) + '</span>'; return; }
  const { error: pe } = await sb.from('posts').insert({ thread_id: thread.id, author_id: currentUser.id, content });
  if (pe) { msgEl.innerHTML = '<span style="color:red">error: ' + esc(pe.message) + '</span>'; return; }
  const nc = (currentProfile?.post_count||0)+1;
  await sb.from('profiles').update({ post_count: nc }).eq('id', currentUser.id);
  if (currentProfile) currentProfile.post_count = nc;
  navigate('thread', { threadId: thread.id });
}

function v(id) { return (document.getElementById(id)?.value||'').trim(); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt(iso) { if(!iso) return '???'; const d=new Date(iso); return d.toLocaleDateString('de-DE')+' '+d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}); }

document.addEventListener('keydown', e => { if (e.key==='Escape') closeModal(); });
(async () => { await initAuth(); navigate('forum'); })();
