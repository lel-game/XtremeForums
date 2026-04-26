/* =========================================================
   XtremeForums - script.js
   ========================================================= */

// --- Init Supabase client ---
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Global state ---
let currentUser    = null;
let currentProfile = null;
let viewStack      = [];
let curState       = { view: 'forum', threadId: null, catId: null };
let editingPostId  = null;
let isNavigating   = false;  // prevents double-clicks triggering double navigation


/* =========================================================
   LOADING HELPERS
   ========================================================= */

// Win98-style progress bar loader shown inside #app-root
function showPageLoader(msg = 'loading...') {
  document.getElementById('app-root').innerHTML = `
    <div style="text-align:center;padding:30px 20px">
      <div style="display:inline-block;border:2px solid;border-color:#808080 #fff #fff #808080;
                  background:#c0c0c0;padding:16px 24px;min-width:220px">
        <div style="font-size:12px;margin-bottom:10px;font-weight:bold">${esc(msg)}</div>
        <div style="border:2px solid;border-color:#808080 #fff #fff #808080;
                    height:16px;background:white;overflow:hidden">
          <div style="height:100%;
                      background:repeating-linear-gradient(
                        90deg,#000080 0px,#000080 12px,#4040c0 12px,#4040c0 24px);
                      background-size:200% 100%;
                      animation:xf-progress 1.2s linear infinite">
          </div>
        </div>
        <div style="font-size:10px;color:#808080;margin-top:6px">pls wait (56k moment)</div>
      </div>
    </div>
    <style>
      @keyframes xf-progress {
        from { background-position: 0 0; }
        to   { background-position: -200% 0; }
      }
    </style>`;
}

// Disable a button and show loading text while an async op runs
function setButtonLoading(btn, loadingText) {
  if (!btn) return;
  btn.disabled       = true;
  btn._originalText  = btn.textContent;
  btn.textContent    = loadingText;
}

function restoreButton(btn) {
  if (!btn) return;
  btn.disabled    = false;
  btn.textContent = btn._originalText || btn.textContent;
}

// Run asyncFn with button disabled + loading text, restore when done
async function withLoading(btn, loadingText, asyncFn) {
  if (btn && btn.disabled) return;
  setButtonLoading(btn, loadingText);
  try {
    await asyncFn();
  } finally {
    restoreButton(btn);
  }
}


/* =========================================================
   AUTH
   ========================================================= */

// Convert username to a fake email so Supabase Auth is happy.
// Users never see or type this email.
function fakeEmail(username) {
  return username.toLowerCase().replace(/[^a-z0-9]/g, '') + '@xtremeforums.fake';
}

async function initAuth() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await loadProfile(session.user);

    // Only handle sign-out here. Login/register load their own profile
    // directly so the UI updates immediately without waiting for this event.
    sb.auth.onAuthStateChange(async (_event, session) => {
      if (!session) {
        currentUser    = null;
        currentProfile = null;
        updateAuthUI();
        renderForum();
      }
    });
  } catch (err) {
    console.error('Auth init error:', err);
  }
}

async function loadProfile(user) {
  currentUser = user;
  try {
    const { data, error } = await sb
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    // PGRST116 = row not found (normal right after sign-up)
    if (error && error.code !== 'PGRST116') throw error;
    currentProfile = data || null;
  } catch (err) {
    console.error('Profile load error:', err);
    currentProfile = null;
  }
  updateAuthUI();
  applyTheme(currentProfile?.theme || 'win98');
}

function applyTheme(theme) {
  const valid = ['win95', 'win98', 'winxp', 'longhorn', 'win7', 'macos'];
  const safe  = valid.includes(theme) ? theme : 'win98';
  document.body.className = 'theme-' + safe;
  localStorage.setItem('xf-theme', safe);
}

function updateAuthUI() {
  const loggedIn = !!currentUser;

  document.getElementById('auth-btn').style.display     = loggedIn ? 'none' : '';
  document.getElementById('settings-btn').style.display = loggedIn ? ''     : 'none';
  document.getElementById('logout-btn').style.display   = loggedIn ? ''     : 'none';

  const greeting = document.getElementById('user-greeting');
  if (loggedIn && currentProfile) {
    const avatar = currentProfile.avatar_url
      ? `<img src="${esc(currentProfile.avatar_url)}" style="width:18px;height:18px;object-fit:cover;border:1px solid #808080;">`
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

  const loginBtn = document.querySelector('#login-form .btn-primary');
  await withLoading(loginBtn, 'logging in...', async () => {
    const { data, error } = await sb.auth.signInWithPassword({
      email: fakeEmail(username),
      password,
    });

    if (error) { showErr('wrong username or password!!!'); return; }

    // Load profile immediately so the greeting updates right away
    await loadProfile(data.user);
    closeModal();
    await renderForum();
  });
}

async function doRegister() {
  clearErr();
  const username  = val('reg-username');
  const password  = document.getElementById('reg-pass').value;
  const sig       = val('reg-sig');
  const fileInput = document.getElementById('reg-avatar-file');

  if (!username || !password)               { showErr('fill in all da fields!!!'); return; }
  if (password.length < 6)                  { showErr('password needs 2 b at least 6 chars!!!'); return; }
  if (!/^[a-zA-Z0-9_\-]+$/.test(username)) { showErr('username: only letters, numbers, _ and - !!!'); return; }

  const regBtn = document.querySelector('#register-form .btn-primary');
  await withLoading(regBtn, 'creating account...', async () => {

    // Check username isn't already taken
    const { data: existing } = await sb
      .from('profiles')
      .select('id')
      .eq('username', username)
      .maybeSingle();
    if (existing) { showErr('username already taken!!!'); return; }

    // Create the Supabase Auth account
    const { data: authData, error: signUpError } = await sb.auth.signUp({
      email: fakeEmail(username),
      password,
    });
    if (signUpError) { showErr('register failed: ' + signUpError.message); return; }

    // Convert avatar to base64 and store directly in the profile row.
    // No storage bucket or upload policies needed this way.
    let avatar_url = '';
    if (fileInput.files[0]) {
      avatar_url = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width  = 128;
            canvas.height = 128;
            canvas.getContext('2d').drawImage(img, 0, 0, 128, 128);
            resolve(canvas.toDataURL('image/jpeg', 0.8));
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(fileInput.files[0]);
      });
    }

    if (authData.user) {
      await sb.from('profiles').insert({
        id: authData.user.id,
        username,
        sig,
        avatar_url,
        post_count: 0,
      });

      // Load profile immediately so greeting updates right away
      await loadProfile(authData.user);
    }

    closeModal();
    await renderForum();
  });
}

async function doLogout() {
  const btn = document.getElementById('logout-btn');
  await withLoading(btn, 'logging out...', async () => {
    await sb.auth.signOut();
    // onAuthStateChange handles clearing state and re-rendering
  });
}

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
  if (isNavigating) return;  // block double-fires while a render is in progress

  curState      = { view, ...data };
  editingPostId = null;
  if (push) viewStack.push({ view, data });

  if      (view === 'forum')     renderForum();
  else if (view === 'thread')    renderThread(data.threadId);
  else if (view === 'newthread') renderNewThread(data.catId);
  else if (view === 'settings')  renderSettings();
  else if (view === 'archive')   renderArchive();
}

function reloadView() {
  if      (curState.view === 'thread')    renderThread(curState.threadId);
  else if (curState.view === 'newthread') renderNewThread(curState.catId);
  else if (curState.view === 'settings')  renderSettings();
  else if (curState.view === 'archive') renderArchive();
  else                                    renderForum();
}


/* =========================================================
   FORUM VIEW  (category list)
   ========================================================= */

async function renderForum() {
  isNavigating  = true;
  viewStack     = [{ view: 'forum', data: {} }];
  curState.view = 'forum';

  showPageLoader('loading forum...');

  try {
    const [
      { data: cats,     error: e1 },
      { data: threads,  error: e2 },
      { data: allPosts, error: e3 },
    ] = await Promise.all([
      sb.from('categories').select('*').order('id'),
      sb.from('threads')
        .select('*, profiles!threads_author_id_fkey(username, avatar_url)')
        .order('pinned',     { ascending: false })
        .order('created_at', { ascending: false }),
      sb.from('posts').select('thread_id'),
    ]);

    if (e1 || e2 || e3) {
      console.error('renderForum errors:', e1, e2, e3);
      document.getElementById('app-root').innerHTML =
        '<div class="error-box">Failed to load forum. Check console (F12).</div>';
      return;
    }

    // reply count per thread (total posts minus the opening post itself)
    const replyCount = {};
    (allPosts || []).forEach(p => {
      replyCount[p.thread_id] = (replyCount[p.thread_id] || 0) + 1;
    });

    const statsHtml = `
      <div class="stats-bar">
        <span>&#128196; Threads: ${(threads || []).length}</span>
        <span>&#128172; Posts: ${(allPosts || []).length}</span>
        <span>&#128101; ${currentProfile
          ? esc(currentProfile.username) + ' - welcome back!!!'
          : 'browsing as Guest'}</span>
      </div>`;

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

    document.getElementById('app-root').innerHTML = statsHtml + categoriesHtml;

  } catch (err) {
    console.error('renderForum error:', err);
    document.getElementById('app-root').innerHTML =
      '<div class="error-box">Failed to load forum. Check console (F12).</div>';
  } finally {
    isNavigating = false;
  }
}


/* =========================================================
   THREAD VIEW  (posts list)
   ========================================================= */

async function renderThread(threadId) {
  isNavigating = true;
  showPageLoader('loading thread...');

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
      document.getElementById('app-root').innerHTML =
        '<div class="error-box">Thread not found!!!</div>';
      return;
    }
    if (e2) console.error('Posts load error:', e2);

    // Count unique views: only logged-in users who aren't the author.
    // The (thread_id, viewer_id) primary key prevents double counting.
    if (currentUser && currentUser.id !== thread.author_id) {
      const { error: viewErr } = await sb
        .from('thread_views')
        .insert({ thread_id: threadId, viewer_id: currentUser.id });

      if (!viewErr) {
        // Row was new, so increment the view counter
        await sb.from('threads')
          .update({ views: (thread.views || 0) + 1 })
          .eq('id', threadId);
      }
      // duplicate key error = already viewed before, do nothing
    }

    const postsHtml = (posts || []).map((post, index) => {
      const profile   = post.profiles || {};
      const isOwnPost = currentUser && currentUser.id === post.author_id;
      const isEditing = editingPostId === post.id;
      const wasEdited = post.updated_at && post.updated_at !== post.created_at;

      const avatarHtml = profile.avatar_url
        ? `<img src="${esc(profile.avatar_url)}" alt="avatar">`
        : '<div class="avatar-placeholder">&#128100;</div>';

      const actionButtons = isOwnPost && !isEditing ? `
        <div class="post-actions">
          <button class="btn98 btn-sm" onclick="startEdit(${post.id})">Edit</button>
          <button class="btn98 btn-sm btn-danger"
            onclick="deletePost(${post.id}, ${threadId}, ${index === 0})">Del</button>
        </div>` : '';

      const bodyHtml = isEditing
        ? `<textarea class="edit-area" id="edit-ta-${post.id}">${esc(post.content)}</textarea>
           <div style="display:flex;gap:5px;margin-top:4px">
             <button class="btn98 btn-primary btn-sm"
               onclick="saveEdit(${post.id}, ${threadId})">Save</button>
             <button class="btn98 btn-sm" onclick="cancelEdit(${threadId})">Cancel</button>
           </div>`
        : `<div class="post-content">${esc(post.content)}</div>
           ${profile.sig ? `<div class="post-sig">${esc(profile.sig)}</div>` : ''}`;

      return `
        <div class="${index > 0 ? 'reply-indent' : ''}" style="margin-bottom:8px"
             id="post-${post.id}">
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

    const replyBox = currentUser
      ? `<div class="win-outer">
           <div class="win-title"><span>&#9997; Post a Reply</span></div>
           <div style="margin:6px">
             <div style="margin-bottom:4px;font-size:11px">
               Posting as: <b>${esc(currentProfile?.username || '???')}</b>
             </div>
             <textarea id="reply-text" style="width:100%;height:90px"
               placeholder="type ur reply xD rawr!!!"></textarea>
             <div style="margin-top:5px;display:flex;gap:6px">
               <button class="btn98 btn-primary" id="reply-btn"
                 onclick="submitReply(${threadId})">Post Reply!!!</button>
               <button class="btn98" onclick="navigate('forum')">Cancel</button>
             </div>
             <div id="reply-msg" style="margin-top:4px"></div>
           </div>
         </div>`
      : `<div class="notice">
           &#128274; <a href="#" onclick="openModal();return false"
             style="color:#000080;font-weight:bold">Login</a> 2 reply!!!
         </div>`;

    document.getElementById('app-root').innerHTML = `
      <div style="margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button class="btn98" onclick="navigate('forum')">&#8592; Back</button>
        <span style="font-weight:bold;font-size:13px">${esc(thread.title)}</span>
      </div>
      ${postsHtml}
      ${replyBox}`;

  } catch (err) {
    console.error('renderThread error:', err);
    document.getElementById('app-root').innerHTML =
      '<div class="error-box">Failed to load thread. Check console (F12).</div>';
  } finally {
    isNavigating = false;
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

  const saveBtn = document.querySelector(`#post-${postId} .btn-primary`);
  await withLoading(saveBtn, 'saving...', async () => {
    const { error } = await sb
      .from('posts')
      .update({ content, updated_at: new Date().toISOString() })
      .eq('id', postId)
      .eq('author_id', currentUser.id);

    if (error) { alert('save failed: ' + error.message); return; }
    editingPostId = null;
    renderThread(threadId);
  });
}

async function deletePost(postId, threadId, isFirstPost) {
  if (isFirstPost) {
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

  const replyBtn = document.getElementById('reply-btn');
  await withLoading(replyBtn, 'posting...', async () => {
    const { error } = await sb.from('posts').insert({
      thread_id: threadId,
      author_id: currentUser.id,
      content,
    });

    if (error) {
      msgEl.innerHTML = `<span style="color:red">error: ${esc(error.message)}</span>`;
      return;
    }

    const newCount = (currentProfile?.post_count || 0) + 1;
    await sb.from('profiles').update({ post_count: newCount }).eq('id', currentUser.id);
    if (currentProfile) currentProfile.post_count = newCount;

    renderThread(threadId);
  });
}


/* =========================================================
   NEW THREAD VIEW
   ========================================================= */

async function renderNewThread(catId) {
  isNavigating = true;
  showPageLoader('loading...');

  try {
    let catName = 'Unknown', catIcon = '';
    const { data: cat } = await sb.from('categories').select('*').eq('id', catId).single();
    if (cat) { catName = cat.name; catIcon = cat.icon || ''; }

    document.getElementById('app-root').innerHTML = `
      <div style="margin-bottom:6px">
        <button class="btn98" onclick="navigate('forum')">&#8592; Back</button>
        <span style="margin-left:8px;font-weight:bold">
          New Thread in: ${esc(catIcon)} ${esc(catName)}
        </span>
      </div>
      <div class="win-outer">
        <div class="win-title"><span>&#9997; Create New Thread</span></div>
        <div style="margin:8px">
          <div style="margin-bottom:8px">
            <label>Thread Title:</label>
            <input type="text" id="new-title"
              placeholder="type ur gr8 thread title here!!!" maxlength="200">
          </div>
          <div style="margin-bottom:8px">
            <label>First Post:</label>
            <textarea id="new-content" style="width:100%;height:110px"
              placeholder="say something!!1! rawr"></textarea>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn98 btn-primary" id="submit-thread-btn"
              onclick="submitThread(${catId})">Post Thread!!!</button>
            <button class="btn98" onclick="navigate('forum')">Cancel</button>
          </div>
          <div id="newthread-msg" style="margin-top:4px"></div>
        </div>
      </div>`;

  } catch (err) {
    console.error('renderNewThread error:', err);
    document.getElementById('app-root').innerHTML =
      '<div class="error-box">Failed to load. Check console (F12).</div>';
  } finally {
    isNavigating = false;
  }
}

async function submitThread(catId) {
  const title   = (document.getElementById('new-title')?.value   || '').trim();
  const content = (document.getElementById('new-content')?.value || '').trim();
  const msgEl   = document.getElementById('newthread-msg');

  if (!title || !content) {
    msgEl.innerHTML = '<span style="color:red">fill in all da fields!!!</span>';
    return;
  }

  const submitBtn = document.getElementById('submit-thread-btn');
  await withLoading(submitBtn, 'posting...', async () => {
    const { data: thread, error: threadErr } = await sb
      .from('threads')
      .insert({ title, category_id: catId, author_id: currentUser.id, views: 0, pinned: false })
      .select()
      .single();

    if (threadErr) {
      msgEl.innerHTML = `<span style="color:red">error: ${esc(threadErr.message)}</span>`;
      return;
    }

    const { error: postErr } = await sb.from('posts').insert({
      thread_id: thread.id,
      author_id: currentUser.id,
      content,
    });

    if (postErr) {
      msgEl.innerHTML = `<span style="color:red">error: ${esc(postErr.message)}</span>`;
      return;
    }

    const newCount = (currentProfile?.post_count || 0) + 1;
    await sb.from('profiles').update({ post_count: newCount }).eq('id', currentUser.id);
    if (currentProfile) currentProfile.post_count = newCount;

    navigate('thread', { threadId: thread.id });
  });
}


/* =========================================================
   SETTINGS VIEW
   ========================================================= */

async function renderSettings() {
  isNavigating  = true;
  curState.view = 'settings';
  showPageLoader('loading settings...');

  // Guard: settings requires login
  if (!currentUser || !currentProfile) {
    document.getElementById('app-root').innerHTML =
      '<div class="error-box">u gotta be logged in 2 access settings!!!</div>';
    isNavigating = false;
    return;
  }

  const avatarHtml = currentProfile.avatar_url
    ? `<img src="${esc(currentProfile.avatar_url)}"
            style="width:80px;height:80px;object-fit:cover;
                   border:2px solid;border-color:#808080 #fff #fff #808080;
                   display:block;margin-bottom:6px">`
    : `<div style="width:80px;height:80px;background:#c0c0c0;
                   border:2px solid;border-color:#808080 #fff #fff #808080;
                   display:flex;align-items:center;justify-content:center;
                   font-size:36px;margin-bottom:6px">&#128100;</div>`;

  document.getElementById('app-root').innerHTML = `
    <div style="margin-bottom:6px;display:flex;align-items:center;gap:8px">
      <button class="btn98" onclick="navigate('forum')">&#8592; Back</button>
      <span style="font-weight:bold;font-size:13px">&#9881; Account Settings</span>
    </div>

    <!-- Current profile summary -->
    <div class="win-outer" style="margin-bottom:8px">
      <div class="win-title"><span>&#128100; Your Profile</span></div>
      <div style="padding:10px;display:flex;align-items:center;gap:12px;background:white;margin:4px">
        ${avatarHtml}
        <div>
          <div style="font-weight:bold;font-size:14px">${esc(currentProfile.username)}</div>
          <div style="font-size:11px;color:#606060;margin-top:2px">${esc(currentProfile.sig || '(no signature)')}</div>
          <div style="font-size:10px;color:#000080;margin-top:4px">${currentProfile.post_count || 0} posts</div>
        </div>
      </div>
    </div>

    <!-- Change username -->
    <div class="win-outer" style="margin-bottom:8px">
      <div class="win-title"><span>&#9999; Change Username</span></div>
      <div style="margin:8px">
        <div class="field">
          <label>New Username:</label>
          <input type="text" id="set-username"
            value="${esc(currentProfile.username)}" maxlength="30">
        </div>
        <div class="field">
          <label>Signature:</label>
          <input type="text" id="set-sig"
            value="${esc(currentProfile.sig || '')}" maxlength="100"
            placeholder="~*~ ur cool sig ~*~">
        </div>
        <button class="btn98 btn-primary" id="save-profile-btn"
          onclick="saveProfile()">Save Changes</button>
        <div id="profile-msg" style="margin-top:5px"></div>
      </div>
    </div>

    <!-- Change avatar -->
    <div class="win-outer" style="margin-bottom:8px">
      <div class="win-title"><span>&#128247; Change Avatar</span></div>
      <div style="margin:8px">
        <div class="field">
          <label>New Avatar Image:</label>
          <input type="file" id="set-avatar-file" accept="image/*"
            onchange="previewSettingsAvatar()">
          <img id="set-avatar-preview" class="avatar-preview"
            style="display:none" src="" alt="preview">
        </div>
        <button class="btn98 btn-primary" id="save-avatar-btn"
          onclick="saveAvatar()">Save Avatar</button>
        <div id="avatar-msg" style="margin-top:5px"></div>
      </div>
    </div>

    <!-- Theme picker -->
    <div class="win-outer" style="margin-bottom:8px">
      <div class="win-title"><span>&#127912; Choose Theme</span></div>
      <div style="margin:8px">
        <div class="theme-grid" id="theme-grid">
          ${buildThemeGrid(currentProfile.theme || 'win98')}
        </div>
        <button class="btn98 btn-primary" id="save-theme-btn"
          onclick="saveTheme()">Apply Theme</button>
        <div id="theme-msg" style="margin-top:5px"></div>
      </div>
    </div>

    <!-- Change password -->
    <div class="win-outer" style="margin-bottom:8px">
      <div class="win-title"><span>&#128274; Change Password</span></div>      <div style="margin:8px">
        <div class="field">
          <label>New Password:</label>
          <input type="password" id="set-pass-new"
            placeholder="min 6 chars!!">
        </div>
        <div class="field">
          <label>Confirm New Password:</label>
          <input type="password" id="set-pass-confirm"
            placeholder="type it again!!!">
        </div>
        <button class="btn98 btn-primary" id="save-pass-btn"
          onclick="savePassword()">Change Password</button>
        <div id="pass-msg" style="margin-top:5px"></div>
      </div>
    </div>`;

  isNavigating = false;
}

const THEMES = [
  { id: 'win95',    label: 'Windows 95'    },
  { id: 'win98',    label: 'Windows 98'    },
  { id: 'winxp',    label: 'Windows XP'    },
  { id: 'longhorn', label: 'Win Longhorn'  },
  { id: 'win7',     label: 'Windows 7'     },
  { id: 'macos',    label: 'macOS Aqua'    },
];

let pendingTheme = null;  // theme picked but not yet saved to DB

function buildThemeGrid(currentTheme) {
  return THEMES.map(t => `
    <div class="theme-option ${t.id === (pendingTheme || currentTheme) ? 'selected' : ''}"
         id="theme-opt-${t.id}"
         onclick="selectTheme('${t.id}')">
      <div class="theme-preview tp-${t.id}">
        <div class="tp-title">${t.label}</div>
        <div class="tp-body">
          <div class="tp-sidebar"></div>
          <div class="tp-content"></div>
        </div>
      </div>
      <div class="theme-label">${t.label}</div>
    </div>`).join('');
}

function selectTheme(themeId) {
  pendingTheme = themeId;
  // Live preview — apply immediately
  applyTheme(themeId);
  // Update selected border in the grid
  document.querySelectorAll('.theme-option').forEach(el => {
    el.classList.toggle('selected', el.id === 'theme-opt-' + themeId);
  });
}

async function saveTheme() {
  if (!pendingTheme) {
    document.getElementById('theme-msg').innerHTML =
      '<span style="color:orange">pick a theme first!!!</span>';
    return;
  }
  const btn = document.getElementById('save-theme-btn');
  await withLoading(btn, 'saving...', async () => {
    const { error } = await sb
      .from('profiles')
      .update({ theme: pendingTheme })
      .eq('id', currentUser.id);

    if (error) {
      document.getElementById('theme-msg').innerHTML =
        `<span style="color:red">error: ${esc(error.message)}</span>`;
      return;
    }

    currentProfile.theme = pendingTheme;
    pendingTheme = null;
    document.getElementById('theme-msg').innerHTML =
      '<span style="color:green">theme saved!!!</span>';
  });
}

function previewSettingsAvatar() {
  const file = document.getElementById('set-avatar-file').files[0];
  const prev = document.getElementById('set-avatar-preview');
  if (file) { prev.src = URL.createObjectURL(file); prev.style.display = 'block'; }
  else       { prev.style.display = 'none'; }
}

async function saveProfile() {
  const newUsername = val('set-username');
  const newSig      = val('set-sig');
  const msgEl       = document.getElementById('profile-msg');

  if (!newUsername) { msgEl.innerHTML = '<span style="color:red">username cant be empty dummy!!!</span>'; return; }
  if (!/^[a-zA-Z0-9_\-]+$/.test(newUsername)) { msgEl.innerHTML = '<span style="color:red">username: only letters, numbers, _ and - !!!</span>'; return; }

  const btn = document.getElementById('save-profile-btn');
  await withLoading(btn, 'saving...', async () => {

    // Check new username isn't taken by someone else
    if (newUsername !== currentProfile.username) {
      const { data: existing } = await sb
        .from('profiles')
        .select('id')
        .eq('username', newUsername)
        .maybeSingle();
      if (existing) { msgEl.innerHTML = '<span style="color:red">username already taken!!!</span>'; return; }
    }

    const { error } = await sb
      .from('profiles')
      .update({ username: newUsername, sig: newSig })
      .eq('id', currentUser.id);

    if (error) { msgEl.innerHTML = `<span style="color:red">error: ${esc(error.message)}</span>`; return; }

    // Update local profile so header refreshes immediately
    currentProfile.username = newUsername;
    currentProfile.sig      = newSig;
    updateAuthUI();

    msgEl.innerHTML = '<span style="color:green">saved!!!</span>';
    // Re-render settings so the profile summary reflects new values
    setTimeout(() => renderSettings(), 800);
  });
}

async function saveAvatar() {
  const fileInput = document.getElementById('set-avatar-file');
  const msgEl     = document.getElementById('avatar-msg');

  if (!fileInput.files[0]) { msgEl.innerHTML = '<span style="color:red">pick an image first!!!</span>'; return; }

  const btn = document.getElementById('save-avatar-btn');
  await withLoading(btn, 'saving...', async () => {

    // Convert to 128x128 base64, same as registration
    const avatar_url = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width  = 128;
          canvas.height = 128;
          canvas.getContext('2d').drawImage(img, 0, 0, 128, 128);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(fileInput.files[0]);
    });

    const { error } = await sb
      .from('profiles')
      .update({ avatar_url })
      .eq('id', currentUser.id);

    if (error) { msgEl.innerHTML = `<span style="color:red">error: ${esc(error.message)}</span>`; return; }

    currentProfile.avatar_url = avatar_url;
    updateAuthUI();

    msgEl.innerHTML = '<span style="color:green">avatar updated!!!</span>';
    setTimeout(() => renderSettings(), 800);
  });
}

async function savePassword() {
  const newPass     = document.getElementById('set-pass-new').value;
  const confirmPass = document.getElementById('set-pass-confirm').value;
  const msgEl       = document.getElementById('pass-msg');

  if (!newPass || !confirmPass) { msgEl.innerHTML = '<span style="color:red">fill both fields!!!</span>'; return; }
  if (newPass.length < 6)       { msgEl.innerHTML = '<span style="color:red">password needs 2 b at least 6 chars!!!</span>'; return; }
  if (newPass !== confirmPass)  { msgEl.innerHTML = '<span style="color:red">passwords dont match dummy!!!</span>'; return; }

  const btn = document.getElementById('save-pass-btn');
  await withLoading(btn, 'saving...', async () => {
    const { error } = await sb.auth.updateUser({ password: newPass });

    if (error) { msgEl.innerHTML = `<span style="color:red">error: ${esc(error.message)}</span>`; return; }

    msgEl.innerHTML = '<span style="color:green">password changed!!!</span>';
    document.getElementById('set-pass-new').value     = '';
    document.getElementById('set-pass-confirm').value = '';
  });
}


/* =========================================================
   ========================================================= */

function val(id) {
  return (document.getElementById(id)?.value || '').trim();
}

function esc(str) {
  return String(str || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

function fmt(iso) {
  if (!iso) return '???';
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE') + ' '
    + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

/* =========================================================
   ARCHIVE VIEW  - file upload/download/delete
   ========================================================= */

async function renderArchive() {
  isNavigating = true;
  curState.view = 'archive';
  showPageLoader('loading archive...');

  try {
    const { data: files, error } = await sb
      .from('archive_files')
      .select('*, profiles(username)')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const uploadForm = currentUser ? `
      <div class="win-outer" style="margin-bottom:8px">
        <div class="win-title"><span>&#128190; Upload File</span></div>
        <div style="margin:6px;font-size:11px">
          <div class="field">
            <label>File:</label>
            <input type="file" id="arch-file-input">
          </div>
          <div class="field">
            <label>Description (optional):</label>
            <input type="text" id="arch-desc" placeholder="what is dis file???" maxlength="100">
          </div>
          <div id="arch-upload-msg" style="margin-top:4px"></div>
          <button class="btn98 btn-primary" id="arch-upload-btn" onclick="archiveUpload()">
            Upload!!!
          </button>
        </div>
      </div>` : `
      <div class="win-outer" style="margin-bottom:8px">
        <div class="win-title"><span>&#128190; Upload File</span></div>
        <div style="margin:6px;font-size:11px;color:#808080">
          u need 2 b logged in 2 upload files dummy!!!
        </div>
      </div>`;

    const rows = (files || []).length === 0
      ? '<tr><td colspan="5" style="color:#808080;font-style:italic;text-align:center">no files yet... be the first 2 upload something!!!</td></tr>'
      : (files || []).map(f => {
          const canDelete = currentUser && currentUser.id === f.uploader_id;
          const deleteBtn = canDelete
            ? `<button class="btn98 btn-sm btn-danger" onclick="archiveDelete('${esc(f.id)}', '${esc(f.storage_path)}')">Del</button>`
            : '';
          const sizeStr = f.file_size
            ? (f.file_size > 1048576
              ? (f.file_size / 1048576).toFixed(1) + ' MB'
              : (f.file_size / 1024).toFixed(1) + ' KB')
            : '???';
          return `
            <tr>
              <td>
                <a class="archive-link" onclick="archiveDownload('${esc(f.storage_path)}', '${esc(f.original_name)}')">
                  &#128196; ${esc(f.original_name)}
                </a>
                ${f.description ? `<br><span style="color:#808080;font-size:10px">${esc(f.description)}</span>` : ''}
              </td>
              <td>${esc(f.profiles?.username || '???')}</td>
              <td>${sizeStr}</td>
              <td>${fmt(f.created_at)}</td>
              <td>${deleteBtn}</td>
            </tr>`;
        }).join('');

    document.getElementById('app-root').innerHTML = `
      ${uploadForm}
      <div class="win-outer">
        <div class="win-title"><span>&#128193; File Archive - ${(files||[]).length} file(s)</span></div>
        <div style="margin:4px">
          <table>
            <thead>
              <tr>
                <th>Filename</th>
                <th>Uploaded by</th>
                <th>Size</th>
                <th>Date</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;

  } catch (err) {
    console.error('renderArchive error:', err);
    document.getElementById('app-root').innerHTML =
      '<div class="error-box">Failed 2 load archive. Check console (F12).</div>';
  } finally {
    isNavigating = false;
  }
}

async function archiveUpload() {
  const fileInput = document.getElementById('arch-file-input');
  const desc      = val('arch-desc');
  const msgEl     = document.getElementById('arch-upload-msg');
  const btn       = document.getElementById('arch-upload-btn');

  if (!fileInput.files[0]) {
    msgEl.innerHTML = '<span style="color:red">pick a file first dummy!!!</span>';
    return;
  }

  const file     = fileInput.files[0];
  const safeName = file.name.replace(/[^a-zA-Z0-9._\-]/g, '_');
  const path     = `${currentUser.id}/${Date.now()}_${safeName}`;

  await withLoading(btn, 'uploading...', async () => {
    const { error: upErr } = await sb.storage
      .from('archive')
      .upload(path, file, { upsert: false });

    if (upErr) {
      msgEl.innerHTML = `<span style="color:red">upload failed: ${esc(upErr.message)}</span>`;
      return;
    }

    const { error: dbErr } = await sb.from('archive_files').insert({
      uploader_id:   currentUser.id,
      original_name: file.name,
      storage_path:  path,
      file_size:     file.size,
      mime_type:     file.type || 'application/octet-stream',
      description:   desc || null,
    });

    if (dbErr) {
      // rollback the storage upload if DB insert fails
      await sb.storage.from('archive').remove([path]);
      msgEl.innerHTML = `<span style="color:red">db error: ${esc(dbErr.message)}</span>`;
      return;
    }

    msgEl.innerHTML = '<span style="color:green">uploaded!!! XD</span>';
    setTimeout(() => renderArchive(), 800);
  });
}

async function archiveDownload(storagePath, originalName) {
  const { data, error } = await sb.storage
    .from('archive')
    .download(storagePath);

  if (error || !data) {
    alert('download failed: ' + (error?.message || 'unknown error'));
    return;
  }

  const url = URL.createObjectURL(data);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = originalName;
  a.click();
  URL.revokeObjectURL(url);
}

async function archiveDelete(fileId, storagePath) {
  if (!confirm('rly delete this file??? (no undo!!! D:)')) return;

  const { error: storErr } = await sb.storage
    .from('archive')
    .remove([storagePath]);

  if (storErr) { alert('storage delete failed: ' + storErr.message); return; }

  const { error: dbErr } = await sb
    .from('archive_files')
    .delete()
    .eq('id', fileId);

  if (dbErr) { alert('db delete failed: ' + dbErr.message); return; }

  renderArchive();
}

/* =========================================================
   BOOT
   ========================================================= */
(async () => {
  // Apply saved theme immediately so there's no flash of default theme
  const savedTheme = localStorage.getItem('xf-theme') || 'win98';
  document.body.className = 'theme-' + savedTheme;

  await initAuth();
  navigate('forum');
})();

/* =========================================================
   WINAMP PLAYER
   ========================================================= */
(function () {
  const PLAYLIST = [
    { title: 'Track 03 - Credits', url: 'https://cdn.discordapp.com/attachments/1498017698179711140/1498018355465027614/07._Credits.mp3?ex=69efa1cf&is=69ee504f&hm=94b4f8753ab0631b4100197609850af15657cdeec261f57a92760955cbd70e0b&' },
    { title: 'Track 04 - Bottom', url: 'https://cdn.discordapp.com/attachments/1498017698179711140/1498018381482164394/17._Bottom.mp3?ex=69efa1d5&is=69ee5055&hm=8cb7d8a259e0ddb7e75b2708c058c784f5a679b90a2d32b8a97d63f3a3698459&' },
    { title: 'Track 02 - gift-plane', url: 'https://cdn.discordapp.com/attachments/1498017698179711140/1498018341464576000/03._gift-plane.mp3?ex=69efa1cc&is=69ee504c&hm=91482ee6f4d724ccf30af5a4d9961229b3708b10b9fff2555968c8afae4ebbe6&' },
    { title: 'Track 01 - Acid Baths and Castration', url: 'https://cdn.discordapp.com/attachments/1498017698179711140/1498017746947145800/Rhodekill_-_I_Fell_In_Love_With_The_Taste_Of_Blood._-_10_Acid_Baths__Castration..mp3?ex=69efa13e&is=69ee4fbe&hm=bf88cb78ffd35d6c686f63e87cb617937c08010461382948704c1356d7959939&' },
  ];

  let cur = 0, isPlaying = false, isShuffle = false;
  const audio = new Audio();
  audio.volume = 0.8;

  const specCount = 18;
  const specEl = document.getElementById('xf-spec');
  const specHeights = Array(specCount).fill(2);
  for (let i = 0; i < specCount; i++) {
    const b = document.createElement('div');
    b.className = 'xf-sbar';
    specEl.appendChild(b);
  }
  const specBars = specEl.querySelectorAll('.xf-sbar');

  function animSpec() {
    specHeights.forEach((h, i) => {
      const target = isPlaying ? (2 + Math.random() * 16) : 2;
      specHeights[i] = h + (target - h) * 0.3;
      specBars[i].style.height = Math.max(2, specHeights[i]).toFixed(1) + 'px';
    });
    requestAnimationFrame(animSpec);
  }
  animSpec();

  function fmtT(s) {
    if (isNaN(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function buildPL() {
    document.getElementById('xf-pl-items').innerHTML = PLAYLIST.map((t, i) => `
      <div class="xf-pl-item ${i === cur ? 'xf-active' : ''}" onclick="xfLoad(${i}, true)">
        <span class="xf-pl-num">${String(i + 1).padStart(2, '0')}</span>
        <span>${esc(t.title)}</span>
      </div>`).join('');
    document.getElementById('xf-plcount').textContent = PLAYLIST.length + ' tracks';
  }

  function updatePL() {
    document.querySelectorAll('.xf-pl-item').forEach((el, i) => {
      el.classList.toggle('xf-active', i === cur);
    });
  }

  function setPlaying(state) {
    isPlaying = state;
    document.getElementById('xf-cd').classList.toggle('spinning', state);
    document.getElementById('xf-pbtn').textContent = state ? '||' : '>';
    document.getElementById('xf-pbtn').classList.toggle('xf-on', state);
  }

  window.xfLoad = function (idx, autoplay) {
    cur = idx;
    audio.src = PLAYLIST[cur].url;
    audio.load();
    document.getElementById('xf-name').textContent = PLAYLIST[cur].title.toUpperCase();
    document.getElementById('xf-pfill').style.width = '0%';
    document.getElementById('xf-time').textContent = '0:00';
    document.getElementById('xf-rem').textContent = '-0:00';
    updatePL();
    if (autoplay) xfPlayPause(true);
  };

  window.xfPlayPause = function (forcePlay) {
    if (isPlaying && !forcePlay) {
      audio.pause();
      setPlaying(false);
    } else {
      if (!audio.src || audio.src === location.href) xfLoad(cur, false);
      audio.play().catch(() => {});
      setPlaying(true);
    }
  };

  window.xfStop = function () {
    audio.pause();
    audio.currentTime = 0;
    setPlaying(false);
    document.getElementById('xf-name').textContent = 'STOPPED';
    document.getElementById('xf-pfill').style.width = '0%';
    document.getElementById('xf-time').textContent = '0:00';
    document.getElementById('xf-rem').textContent = '-0:00';
    document.getElementById('xf-cur').textContent = '0:00';
    document.getElementById('xf-dur').textContent = '0:00';
  };

  window.xfNext = function () {
    const next = isShuffle
      ? Math.floor(Math.random() * PLAYLIST.length)
      : (cur + 1) % PLAYLIST.length;
    xfLoad(next, isPlaying);
  };

  window.xfPrev = function () {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    xfLoad((cur - 1 + PLAYLIST.length) % PLAYLIST.length, isPlaying);
  };

  window.xfShuffle = function () {
    isShuffle = !isShuffle;
    document.getElementById('xf-shuf').classList.toggle('xf-on', isShuffle);
  };

  window.xfSeek = function (e) {
    if (!audio.duration) return;
    const r = document.getElementById('xf-prog').getBoundingClientRect();
    audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
  };

  window.xfVol = function (e) {
    const r = document.getElementById('xf-vtrack').getBoundingClientRect();
    const v = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    audio.volume = v;
    document.getElementById('xf-vfill').style.width = (v * 100) + '%';
    document.getElementById('xf-vnum').textContent = Math.round(v * 100);
  };

  window.xfTogglePL = function () {
    const pl = document.getElementById('xf-pl');
    pl.style.display = pl.style.display === 'none' ? '' : 'none';
  };

  window.xfClose = function () {
    xfStop();
    document.getElementById('xf-player-wrap').style.display = 'none';
  };

  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    const pct = audio.currentTime / audio.duration * 100;
    document.getElementById('xf-pfill').style.width = pct + '%';
    document.getElementById('xf-time').textContent = fmtT(audio.currentTime);
    document.getElementById('xf-rem').textContent = '-' + fmtT(audio.duration - audio.currentTime);
    document.getElementById('xf-cur').textContent = fmtT(audio.currentTime);
    document.getElementById('xf-dur').textContent = fmtT(audio.duration);
  });

  audio.addEventListener('ended', xfNext);

  xfLoad(0, false);
  buildPL();
})();
