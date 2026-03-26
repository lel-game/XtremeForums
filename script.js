/* =========================================================
   XtremeForums - script.js
   ========================================================= */

// --- Init Supabase client ---
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Global state ---
let currentUser    = null;   // logged-in auth user object
let currentProfile = null;   // logged-in user's profile row
let viewStack      = [];     // navigation history for back button
let curState       = { view: 'forum', threadId: null, catId: null };
let editingPostId  = null;   // which post is currently being edited


/* =========================================================
   AUTH
   ========================================================= */

// Turn a username into a fake email so Supabase Auth is happy.
// Users never see or type an email.
function fakeEmail(username) {
  const clean = username.toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean + '@xtremeforums.fake';
}

// On page load, restore session and subscribe to auth changes.
async function initAuth() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await loadProfile(session.user);

    sb.auth.onAuthStateChange(async (_event, session) => {
      if (session) {
        await loadProfile(session.user);
      } else {
        currentUser    = null;
        currentProfile = null;
        updateAuthUI();
      }
    });
  } catch (err) {
    console.error('Auth init error:', err);
  }
}

// Fetch the profile row for a given auth user.
async function loadProfile(user) {
  currentUser = user;
  try {
    const { data, error } = await sb
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    // PGRST116 = row not found, which is fine right after sign-up
    if (error && error.code !== 'PGRST116') throw error;
    currentProfile = data || null;
  } catch (err) {
    console.error('Profile load error:', err);
    currentProfile = null;
  }
  updateAuthUI();
}

// Refresh the top-bar UI to reflect login state.
function updateAuthUI() {
  const loggedIn = !!currentUser;

  document.getElementById('auth-btn').style.display   = loggedIn ? 'none' : '';
  document.getElementById('logout-btn').style.display = loggedIn ? ''     : 'none';

  const greeting = document.getElementById('user-greeting');
  if (loggedIn && currentProfile) {
    const avatar = currentProfile.avatar_url
      ? `<img src="${esc(currentProfile.avatar_url)}">`
      : '&#128100;';
    greeting.innerHTML = avatar + ' ' + esc(currentProfile.username);
  } else {
    greeting.innerHTML = '';
  }
}

async function doLogin() {
  clearErr();
  const username = val('login-username');
  const password = document.getElementById('login-pass').value;

  if (!username || !password) { showErr('fill both fields dummy!!!'); return; }

  const { error } = await sb.auth.signInWithPassword({
    email: fakeEmail(username),
    password,
  });

  if (error) { showErr('wrong username or password!!!'); return; }
  closeModal();
  reloadView();
}

async function doRegister() {
  clearErr();
  const username  = val('reg-username');
  const password  = document.getElementById('reg-pass').value;
  const sig       = val('reg-sig');
  const fileInput = document.getElementById('reg-avatar-file');

  // Validation
  if (!username || !password)             { showErr('fill in all da fields!!!'); return; }
  if (password.length < 6)                { showErr('password needs 2 b at least 6 chars!!!'); return; }
  if (!/^[a-zA-Z0-9_\-]+$/.test(username)) { showErr('username: only letters, numbers, _ and - !!!'); return; }

  // Check username isn't already taken
  const { data: existing } = await sb
    .from('profiles')
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (existing) { showErr('username already taken!!!'); return; }

  // Create auth account
  const { data: authData, error: signUpError } = await sb.auth.signUp({
    email: fakeEmail(username),
    password,
  });
  if (signUpError) { showErr('register failed: ' + signUpError.message); return; }

  // Upload avatar image (if one was selected)
  let avatar_url = '';
  if (authData.user && fileInput.files[0]) {
    const file = fileInput.files[0];
    const ext  = file.name.split('.').pop();
    const path = `${authData.user.id}/avatar.${ext}`;

    const { error: uploadError } = await sb.storage
      .from('avatars')
      .upload(path, file, { upsert: true });
      console.log('upload path:', path);
      console.log('upload error:', upErr);
      console.log('file:', file.name, file.size, file.type);}

    if (!uploadError) {
      const { data: urlData } = sb.storage.from('avatars').getPublicUrl(path);
      avatar_url = urlData.publicUrl;
    }
  
  
  }

  // Insert profile row
  if (authData.user) {
    await sb.from('profiles').insert({
      id: authData.user.id,
      username,
      sig,
      avatar_url,
      post_count: 0,
    });
  }

  closeModal();
  reloadView();
}

async function doLogout() {
  await sb.auth.signOut();
  reloadView();
}

// Modal helpers
function openModal()  { document.getElementById('modal-bg').classList.add('show'); clearErr(); }
function closeModal() { document.getElementById('modal-bg').classList.remove('show'); }

function switchTab(tab) {
  document.getElementById('login-form').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('register-form').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('tab-login').className    = 'tab' + (tab === 'login'    ? ' active' : '');
  document.getElementById('tab-register').className = 'tab' + (tab === 'register' ? ' active' : '');
  clearErr();
}

function showErr(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = '';
}
function clearErr() {
  document.getElementById('auth-error').style.display = 'none';
}

function previewAvatar() {
  const file = document.getElementById('reg-avatar-file').files[0];
  const prev = document.getElementById('avatar-preview');
  if (file) { prev.src = URL.createObjectURL(file); prev.style.display = 'block'; }
  else       { prev.style.display = 'none'; }
}


/* =========================================================
   NAVIGATION
   ========================================================= */

function goBack() {
  if (viewStack.length > 1) {
    viewStack.pop();
    const prev = viewStack[viewStack.length - 1];
    navigate(prev.view, prev.data, false);
  }
}

function navigate(view, data = {}, push = true) {
  curState      = { view, ...data };
  editingPostId = null;
  if (push) viewStack.push({ view, data });

  if      (view === 'forum')     renderForum();
  else if (view === 'thread')    renderThread(data.threadId);
  else if (view === 'newthread') renderNewThread(data.catId);
}

function reloadView() {
  if      (curState.view === 'thread')    renderThread(curState.threadId);
  else if (curState.view === 'newthread') renderNewThread(curState.catId);
  else                                    renderForum();
}


/* =========================================================
   FORUM VIEW  (category list)
   ========================================================= */

async function renderForum() {
  viewStack  = [{ view: 'forum', data: {} }];
  curState.view = 'forum';

  const root = document.getElementById('app-root');
  root.innerHTML = '<div class="loading-msg">loading forum...</div>';

  try {
    // NOTE: use !threads_author_id_fkey to disambiguate the profiles join
    // (threads has two FK paths to profiles: author_id and thread_views)
    const [
      { data: cats,     error: e1 },
      { data: threads,  error: e2 },
      { data: allPosts, error: e3 },
    ] = await Promise.all([
      sb.from('categories').select('*').order('id'),
      sb.from('threads')
        .select('*, profiles!threads_author_id_fkey(username, avatar_url)')
        .order('pinned',      { ascending: false })
        .order('created_at',  { ascending: false }),
      sb.from('posts').select('thread_id'),
    ]);

    if (e1 || e2 || e3) {
      console.error('renderForum errors:', e1, e2, e3);
      root.innerHTML = '<div class="error-box">Failed to load forum data. Check console.</div>';
      return;
    }

    // Build a map of thread_id → reply count
    const replyCount = {};
    (allPosts || []).forEach(p => {
      replyCount[p.thread_id] = (replyCount[p.thread_id] || 0) + 1;
    });

    // Stats bar
    const statsHtml = `
      <div class="stats-bar">
        <span>&#128196; Threads: ${(threads || []).length}</span>
        <span>&#128172; Posts: ${(allPosts || []).length}</span>
        <span>&#128101; ${currentProfile ? esc(currentProfile.username) + ' - welcome back!!!' : 'browsing as Guest'}</span>
      </div>`;

    // One win-outer box per category
    const categoriesHtml = (cats || []).map(cat => {
      const catThreads = (threads || []).filter(t => t.category_id === cat.id);

      const rowsHtml = catThreads.length === 0
        ? '<tr><td colspan="5" style="color:#808080;font-style:italic;text-align:center">no threads yet... u go first!!!</td></tr>'
        : catThreads.map(thread => {
            const authorAvatar = thread.profiles?.avatar_url
              ? `<img class="thread-avatar" src="${esc(thread.profiles.avatar_url)}">`
              : '';
            const replies = Math.max(0, (replyCount[thread.id] || 1) - 1);

            return `
              <tr class="clickable" onclick="navigate('thread', { threadId: ${thread.id} })">
                <td>${thread.pinned ? '&#128204; ' : ''}<b>${esc(thread.title)}</b></td>
                <td>${authorAvatar}${esc(thread.profiles?.username || '???')}</td>
                <td>${replies}</td>
                <td>${thread.views || 0}</td>
                <td>${fmt(thread.created_at)}</td>
              </tr>`;
          }).join('');

      const newThreadBtn = currentUser
        ? `<button class="btn98 btn-primary" onclick="navigate('newthread', { catId: ${cat.id} })">+ New Thread</button>`
        : `<span style="font-size:10px;color:#808080">login 2 post!!!</span>`;

      return `
        <div class="win-outer" style="margin-bottom:8px">
          <div class="win-title">
            <span>${esc(cat.icon || '')} ${esc(cat.name)}</span>
            <span style="font-size:10px;color:#a0c0ff">${esc(cat.description || '')}</span>
          </div>
          <div style="margin:4px">
            <table>
              <thead>
                <tr><th>Thread</th><th>Author</th><th>Replies</th><th>Views</th><th>Date</th></tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
            <div style="margin-top:5px;text-align:right">${newThreadBtn}</div>
          </div>
        </div>`;
    }).join('');

    root.innerHTML = statsHtml + categoriesHtml;

  } catch (err) {
    console.error('renderForum error:', err);
    root.innerHTML = '<div class="error-box">Failed to load forum. Check console.</div>';
  }
}


/* =========================================================
   THREAD VIEW  (posts list)
   ========================================================= */

async function renderThread(threadId) {
  const root = document.getElementById('app-root');
  root.innerHTML = '<div class="loading-msg">loading thread...</div>';

  try {
    const [
      { data: thread, error: e1 },
      { data: posts,  error: e2 },
    ] = await Promise.all([
      sb.from('threads')
        .select('*, categories(name, icon)')
        .eq('id', threadId)
        .single(),
      sb.from('posts')
        .select('*, profiles(username, avatar_url, sig, post_count)')
        .eq('thread_id', threadId)
        .order('created_at'),
    ]);

    if (e1 || !thread) {
      root.innerHTML = '<div class="error-box">Thread not found!!!</div>';
      return;
    }
    if (e2) console.error('Posts load error:', e2);

    // Count this as a view only if:
    //   - the viewer is logged in
    //   - the viewer is NOT the thread author
    // The (thread_id, viewer_id) primary key prevents double-counting.
    if (currentUser && currentUser.id !== thread.author_id) {
      const { error: viewErr } = await sb
        .from('thread_views')
        .insert({ thread_id: threadId, viewer_id: currentUser.id });

      // viewErr being null means the row was new → increment counter
      if (!viewErr) {
        await sb.from('threads')
          .update({ views: (thread.views || 0) + 1 })
          .eq('id', threadId);
      }
      // duplicate key error = already viewed → do nothing
    }

    // Build HTML for each post
    const postsHtml = (posts || []).map((post, index) => {
      const profile  = post.profiles || {};
      const isOwnPost  = currentUser && currentUser.id === post.author_id;
      const isEditing  = editingPostId === post.id;
      const wasEdited  = post.updated_at && post.updated_at !== post.created_at;

      const avatarHtml = profile.avatar_url
        ? `<img src="${esc(profile.avatar_url)}" alt="avatar">`
        : '<div class="avatar-placeholder">&#128100;</div>';

      // Edit / Delete buttons only shown to the post's author
      const actionButtons = isOwnPost && !isEditing ? `
        <div class="post-actions">
          <button class="btn98 btn-sm" onclick="startEdit(${post.id})">Edit</button>
          <button class="btn98 btn-sm btn-danger" onclick="deletePost(${post.id}, ${threadId}, ${index === 0})">Del</button>
        </div>` : '';

      // Body is either an editable textarea or rendered content
      const bodyHtml = isEditing
        ? `<textarea class="edit-area" id="edit-ta-${post.id}">${esc(post.content)}</textarea>
           <div style="display:flex;gap:5px">
             <button class="btn98 btn-primary btn-sm" onclick="saveEdit(${post.id}, ${threadId})">Save</button>
             <button class="btn98 btn-sm" onclick="cancelEdit(${threadId})">Cancel</button>
           </div>`
        : `<div class="post-content">${esc(post.content)}</div>
           ${profile.sig ? `<div class="post-sig">${esc(profile.sig)}</div>` : ''}`;

      return `
        <div class="${index > 0 ? 'reply-indent' : ''}" style="margin-bottom:8px" id="post-${post.id}">
          <div class="post-card">
            <div class="post-head">
              <span class="uname">${esc(profile.username || '???')}</span>
              <span class="meta">${fmt(post.created_at)}${wasEdited ? ' (edited)' : ''}</span>
              ${actionButtons}
            </div>
            <div class="post-inner">
              <div class="avatar-col">
                ${avatarHtml}
                <div class="uname-small">${esc(profile.username || '???')}</div>
                <span class="online-dot"></span>
                <div class="post-count-label">${profile.post_count || 0} posts</div>
              </div>
              <div class="post-body-wrap">${bodyHtml}</div>
            </div>
          </div>
        </div>`;
    }).join('');

    // Reply box at the bottom (only for logged-in users)
    const replyBox = currentUser
      ? `<div class="win-outer">
           <div class="win-title"><span>&#9997; Post a Reply</span></div>
           <div style="margin:6px">
             <div style="margin-bottom:4px;font-size:11px">
               Posting as: <b>${esc(currentProfile?.username || '???')}</b>
             </div>
             <textarea id="reply-text" style="width:100%;height:90px" placeholder="type ur reply xD rawr!!!"></textarea>
             <div style="margin-top:5px;display:flex;gap:6px">
               <button class="btn98 btn-primary" onclick="submitReply(${threadId})">Post Reply!!!</button>
               <button class="btn98" onclick="navigate('forum')">Cancel</button>
             </div>
             <div id="reply-msg" style="margin-top:4px"></div>
           </div>
         </div>`
      : `<div class="notice">
           &#128274; <a href="#" onclick="openModal();return false" style="color:#000080;font-weight:bold">Login</a>
           2 reply!!!
         </div>`;

    root.innerHTML = `
      <div style="margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button class="btn98" onclick="navigate('forum')">&#8592; Back</button>
        <span style="font-weight:bold;font-size:13px">${esc(thread.title)}</span>
      </div>
      ${postsHtml}
      ${replyBox}`;

  } catch (err) {
    console.error('renderThread error:', err);
    root.innerHTML = '<div class="error-box">Failed to load thread. Check console.</div>';
  }
}


/* =========================================================
   POST ACTIONS  (edit / delete / reply)
   ========================================================= */

function startEdit(postId) {
  editingPostId = postId;
  renderThread(curState.threadId);
}

function cancelEdit(threadId) {
  editingPostId = null;
  renderThread(threadId);
}

async function saveEdit(postId, threadId) {
  const content = (document.getElementById(`edit-ta-${postId}`)?.value || '').trim();
  if (!content) { alert('cant save an empty post dummy!!!'); return; }

  const { error } = await sb
    .from('posts')
    .update({ content, updated_at: new Date().toISOString() })
    .eq('id', postId)
    .eq('author_id', currentUser.id);  // RLS also protects this but double-check here

  if (error) { alert('save failed: ' + error.message); return; }

  editingPostId = null;
  renderThread(threadId);
}

async function deletePost(postId, threadId, isFirstPost) {
  if (isFirstPost) {
    // First post = the thread itself; delete the whole thread
    if (!confirm('deleting the first post will delete the WHOLE thread!!! u sure???')) return;

    const { error } = await sb
      .from('threads')
      .delete()
      .eq('id', threadId)
      .eq('author_id', currentUser.id);

    if (error) { alert('delete failed: ' + error.message); return; }
    navigate('forum');

  } else {
    if (!confirm('delete this post??? cant undo!!!')) return;

    const { error } = await sb
      .from('posts')
      .delete()
      .eq('id', postId)
      .eq('author_id', currentUser.id);

    if (error) { alert('delete failed: ' + error.message); return; }

    // Decrement post counter on profile
    const newCount = Math.max(0, (currentProfile?.post_count || 1) - 1);
    await sb.from('profiles').update({ post_count: newCount }).eq('id', currentUser.id);
    if (currentProfile) currentProfile.post_count = newCount;

    renderThread(threadId);
  }
}

async function submitReply(threadId) {
  const content = (document.getElementById('reply-text')?.value || '').trim();
  const msgEl   = document.getElementById('reply-msg');

  if (!content)     { msgEl.innerHTML = '<span style="color:red">type something first dummy!!!</span>'; return; }
  if (!currentUser) { msgEl.innerHTML = '<span style="color:red">you must be logged in!!!</span>'; return; }

  const { error } = await sb.from('posts').insert({
    thread_id: threadId,
    author_id: currentUser.id,
    content,
  });

  if (error) { msgEl.innerHTML = `<span style="color:red">error: ${esc(error.message)}</span>`; return; }

  // Increment post counter
  const newCount = (currentProfile?.post_count || 0) + 1;
  await sb.from('profiles').update({ post_count: newCount }).eq('id', currentUser.id);
  if (currentProfile) currentProfile.post_count = newCount;

  renderThread(threadId);
}


/* =========================================================
   NEW THREAD VIEW
   ========================================================= */

async function renderNewThread(catId) {
  const root = document.getElementById('app-root');
  let catName = 'Unknown', catIcon = '';

  try {
    const { data: cat } = await sb.from('categories').select('*').eq('id', catId).single();
    if (cat) { catName = cat.name; catIcon = cat.icon || ''; }
  } catch (err) {
    console.warn('Category fetch failed:', err);
  }

  root.innerHTML = `
    <div style="margin-bottom:6px">
      <button class="btn98" onclick="navigate('forum')">&#8592; Back</button>
      <span style="margin-left:8px;font-weight:bold">New Thread in: ${esc(catIcon)} ${esc(catName)}</span>
    </div>
    <div class="win-outer">
      <div class="win-title"><span>&#9997; Create New Thread</span></div>
      <div style="margin:8px">
        <div style="margin-bottom:8px">
          <label>Thread Title:</label>
          <input type="text" id="new-title" placeholder="type ur gr8 thread title here!!!" maxlength="200">
        </div>
        <div style="margin-bottom:8px">
          <label>First Post:</label>
          <textarea id="new-content" style="width:100%;height:110px" placeholder="say something!!1! rawr"></textarea>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn98 btn-primary" onclick="submitThread(${catId})">Post Thread!!!</button>
          <button class="btn98" onclick="navigate('forum')">Cancel</button>
        </div>
        <div id="newthread-msg" style="margin-top:4px"></div>
      </div>
    </div>`;
}

async function submitThread(catId) {
  const title   = (document.getElementById('new-title')?.value   || '').trim();
  const content = (document.getElementById('new-content')?.value || '').trim();
  const msgEl   = document.getElementById('newthread-msg');

  if (!title || !content) {
    msgEl.innerHTML = '<span style="color:red">fill in all da fields!!!</span>';
    return;
  }

  // Create the thread row
  const { data: thread, error: threadErr } = await sb
    .from('threads')
    .insert({ title, category_id: catId, author_id: currentUser.id, views: 0, pinned: false })
    .select()
    .single();

  if (threadErr) {
    msgEl.innerHTML = `<span style="color:red">error: ${esc(threadErr.message)}</span>`;
    return;
  }

  // Create the opening post
  const { error: postErr } = await sb.from('posts').insert({
    thread_id: thread.id,
    author_id: currentUser.id,
    content,
  });

  if (postErr) {
    msgEl.innerHTML = `<span style="color:red">error: ${esc(postErr.message)}</span>`;
    return;
  }

  // Increment post counter
  const newCount = (currentProfile?.post_count || 0) + 1;
  await sb.from('profiles').update({ post_count: newCount }).eq('id', currentUser.id);
  if (currentProfile) currentProfile.post_count = newCount;

  navigate('thread', { threadId: thread.id });
}


/* =========================================================
   UTILITIES
   ========================================================= */

// Get trimmed input value by element ID
function val(id) {
  return (document.getElementById(id)?.value || '').trim();
}

// Escape HTML to prevent XSS
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Format an ISO timestamp into German locale (dd.mm.yyyy hh:mm)
function fmt(iso) {
  if (!iso) return '???';
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE') + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// Close modal on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});


/* =========================================================
   BOOT
   ========================================================= */
(async () => {
  await initAuth();
  navigate('forum');
})();
