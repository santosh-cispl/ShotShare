/*
 * ShotShare – UI: paste / drag & drop / pick uploads, gallery with filters,
 * bulk delete, storage meter and session handling.
 */
(function (window, $) {
  'use strict';

  var Dbx = window.DropboxClient;
  var cfg = window.SHOTSHARE_CONFIG || {};
  var MAX_CONCURRENT = Math.max(1, cfg.maxConcurrentUploads || 2);
  var IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg|ico)$/i;
  var THUMB_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|ppm)$/i;
  var THUMB_MAX_BYTES = 20 * 1024 * 1024;
  var UPLOAD_MAX_BYTES = 150 * 1024 * 1024;
  var THUMB_BATCH = 25;
  var MIME_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/heic': 'heic'
  };
  // Inclusive [start, end] in HH:MM; a start after the end wraps past midnight.
  var TIME_PRESETS = {
    morning: ['05:00', '11:59'],
    afternoon: ['12:00', '16:59'],
    evening: ['17:00', '20:59'],
    night: ['21:00', '04:59']
  };

  var state = {
    signedIn: false,
    view: null,
    images: [],
    cards: {},
    thumbs: {},
    selected: new Set(),
    galleryLoaded: false,
    galleryLoading: false,
    queue: [],
    tasks: [],
    active: 0
  };

  /* ---------- helpers ---------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function formatBytes(bytes) {
    var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    var i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return (i === 0 ? bytes : bytes.toFixed(bytes < 10 ? 1 : 0)) + ' ' + units[i];
  }

  function formatDate(date) {
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatTime(date) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function toMinutes(hhmm) {
    var parts = hhmm.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  function screenshotName(file, index) {
    var d = new Date();
    var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());
    return 'screenshot-' + stamp + (index ? '-' + (index + 1) : '') + '.' + (MIME_EXT[file.type] || 'png');
  }

  // Strip characters Dropbox rejects in file names.
  function sanitizeName(name) {
    return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '') || 'image.png';
  }

  function isImageFile(file) {
    return /^image\//.test(file.type) || IMAGE_EXT.test(file.name || '');
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function toast(message, type) {
    type = type || 'info';
    var $toast = $('<div class="toast">').addClass('toast-' + type)
      .attr('role', type === 'error' ? 'alert' : 'status')
      .append($('<span class="toast-msg">').text(message))
      .append($('<button class="toast-close" type="button" aria-label="Dismiss">&times;</button>'));
    var timer = setTimeout(close, type === 'error' ? 9000 : 4000);
    function close() {
      clearTimeout(timer);
      $toast.addClass('leaving');
      setTimeout(function () { $toast.remove(); }, 200);
    }
    $toast.find('.toast-close').on('click', close);
    $('#toasts').append($toast);
  }

  function handleError(err) {
    if (!err) return;
    if (window.console) console.error(err);
    // Expired sessions are reported once by the dropbox:signedout handler.
    if (!err.authExpired) toast(err.message || String(err), 'error');
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var $tmp = $('<textarea readonly>').val(text).css({ position: 'fixed', top: 0, left: 0, opacity: 0 }).appendTo('body');
      $tmp[0].select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* fall through */ }
      $tmp.remove();
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }

  function flashButton($btn, text) {
    var original = $btn.data('label') || $btn.text();
    $btn.data('label', original).text(text).addClass('flash');
    clearTimeout($btn.data('timer'));
    $btn.data('timer', setTimeout(function () { $btn.text(original).removeClass('flash'); }, 1600));
  }

  function fromTemplate(id) {
    return $($.parseHTML($('#' + id).html().trim()));
  }

  function confirmDialog(opts) {
    var dialog = $('#confirm-dialog')[0];
    if (!dialog.showModal) return Promise.resolve(window.confirm(opts.title + '\n\n' + opts.message));
    $('#confirm-title').text(opts.title);
    $('#confirm-message').text(opts.message);
    $('#confirm-ok').text(opts.confirmLabel || 'OK');
    return new Promise(function (resolve) {
      dialog.returnValue = '';
      $(dialog).one('close', function () { resolve(dialog.returnValue === 'confirm'); });
      dialog.showModal();
    });
  }

  /* ---------- views & session ---------- */

  function showView(name) {
    if (!state.signedIn) name = 'login';
    state.view = name;
    // Matches the inline script in <head> that hides the landing page before first paint.
    document.documentElement.classList.toggle('has-session', name !== 'login');
    $('.view').prop('hidden', true);
    $('#view-' + name).prop('hidden', false);
    $('.nav-link').removeClass('active').removeAttr('aria-current')
      .filter('[data-view="' + name + '"]').addClass('active').attr('aria-current', 'page');
    if (name === 'gallery' && !state.galleryLoaded && !state.galleryLoading) loadGallery();
  }

  function route() {
    showView(window.location.hash === '#gallery' ? 'gallery' : 'upload');
  }

  function enterApp() {
    state.signedIn = true;
    $('body').addClass('signed-in');
    route();
    loadAccount();
    loadStorage();
  }

  function leaveApp() {
    state.signedIn = false;
    state.images = [];
    state.cards = {};
    state.thumbs = {};
    state.selected.clear();
    state.galleryLoaded = false;
    state.queue = [];
    state.tasks = [];
    $('body').removeClass('signed-in');
    $('#upload-list, #gallery-grid').empty();
    $('#uploads').prop('hidden', true);
    $('#account-name, #account-avatar').empty();
    $('#storage-text').text('Loading…');
    $('#storage-fill').css('width', 0);
    showView('login');
  }

  function showLoginSetup() {
    var problems = [];
    $('#redirect-uri').text(Dbx.redirectUri());
    if (!Dbx.isConfigured()) {
      problems.push('Add your Dropbox app key to js/config.js and register this redirect URI in the Dropbox App Console: ' + Dbx.redirectUri());
    }
    if (!window.isSecureContext) {
      problems.push('Open the app over https:// or http://localhost — Dropbox sign-in will not work from this address.');
    }
    $('#setup-text').text(problems.join(' '));
    $('#setup-note').prop('hidden', !problems.length);
  }

  function loadAccount() {
    Dbx.getAccount().then(function (account) {
      var name = account.name && account.name.display_name || account.email;
      $('#account-name').text(name).attr('title', account.email);
      var $avatar = $('#account-avatar').empty();
      if (account.profile_photo_url) {
        $avatar.append($('<img alt="">').attr('src', account.profile_photo_url));
      } else {
        $avatar.text((account.name && account.name.abbreviated_name) || name.charAt(0).toUpperCase());
      }
    }).catch(handleError);
  }

  function loadStorage() {
    return Dbx.getSpaceUsage().then(function (usage) {
      var alloc = usage.allocation || {};
      var used = usage.used;
      var total = alloc.allocated || 0;
      if (alloc['.tag'] === 'team') {
        if (alloc.user_within_team_space_allocated) total = alloc.user_within_team_space_allocated;
        else used = alloc.used;
      }
      var pct = total ? Math.min(100, used / total * 100) : 0;
      $('#storage-text').text(formatBytes(used) + ' of ' + (total ? formatBytes(total) : 'unknown') + ' used');
      $('#storage-fill').css('width', pct + '%').toggleClass('warn', pct >= 80 && pct < 95).toggleClass('danger', pct >= 95);
      $('#storage-meter').attr('aria-valuenow', Math.round(pct));
      $('#storage').attr('title', pct.toFixed(1) + '% of your Dropbox storage used');
    }).catch(handleError);
  }

  /* ---------- uploads ---------- */

  function addFiles(files, fromPaste) {
    if (!state.signedIn) {
      toast('Sign in with Dropbox to upload images.', 'error');
      return;
    }
    var added = 0;
    $.each(files, function (i, file) {
      if (!isImageFile(file)) {
        toast('"' + (file.name || 'File') + '" is not an image, so it was skipped.', 'error');
        return;
      }
      if (file.size > UPLOAD_MAX_BYTES) {
        toast('"' + file.name + '" is larger than 150 MB, so it was skipped.', 'error');
        return;
      }
      var name = fromPaste && (!file.name || /^image\.\w+$/i.test(file.name))
        ? screenshotName(file, i)
        : sanitizeName(file.name);
      enqueue(createTask(file, name));
      added++;
    });
    if (added && state.view !== 'upload') window.location.hash = '#upload';
  }

  function createTask(file, name) {
    var $item = fromTemplate('tpl-upload-item');
    var task = { file: file, name: name, $item: $item, meta: null, url: null, status: 'queued' };
    task.preview = URL.createObjectURL(file);
    $item.find('.upload-thumb img').attr('src', task.preview).on('error', function () {
      $(this).closest('.upload-thumb').addClass('no-thumb');
    });
    $item.find('.upload-name').text(name).attr('title', name);
    $item.data('task', task);
    $('#upload-list').prepend($item);
    $('#uploads').prop('hidden', false);
    state.tasks.push(task);
    setTaskStatus(task, 'queued');
    return task;
  }

  function setTaskProgress(task, fraction) {
    var pct = Math.round(fraction * 100);
    task.$item.find('.progress-fill').css('width', pct + '%');
    task.$item.find('.progress').attr('aria-valuenow', pct);
    if (task.status === 'uploading') task.$item.find('.upload-status').text('Uploading ' + pct + '%');
  }

  function setTaskStatus(task, status, message) {
    var labels = { queued: 'Waiting…', uploading: 'Uploading 0%', linking: 'Creating link…', done: 'Uploaded', error: 'Failed' };
    var $item = task.$item;
    task.status = status;
    $item.attr('data-status', status);
    $item.find('.upload-status').text(labels[status]);
    $item.find('.progress').prop('hidden', status === 'done' || status === 'error');
    $item.find('.upload-error').prop('hidden', status !== 'error');
    $item.find('.upload-error-msg').text(message || '');
    if (status === 'done') {
      var $row = $item.find('.link-row').prop('hidden', false);
      $row.find('.link-input').val(task.url);
      $row.find('.btn-open').attr('href', task.url);
    }
  }

  function enqueue(task) {
    state.queue.push(task);
    pumpQueue();
  }

  function pumpQueue() {
    while (state.active < MAX_CONCURRENT && state.queue.length) runTask(state.queue.shift());
  }

  function runTask(task) {
    state.active++;
    var upload;
    if (task.meta) {
      upload = Promise.resolve(task.meta);
    } else {
      setTaskStatus(task, 'uploading');
      setTaskProgress(task, 0);
      upload = Dbx.uploadFile(task.file, '/' + task.name, function (fraction) { setTaskProgress(task, fraction); });
    }
    upload.then(function (meta) {
      task.meta = meta;
      // Dropbox may have renamed the file to avoid a clash.
      task.$item.find('.upload-name').text(meta.name).attr('title', meta.path_display);
      setTaskProgress(task, 1);
      setTaskStatus(task, 'linking');
      return Dbx.createSharedLink(meta.path_lower);
    }).then(function (url) {
      task.url = url;
      setTaskStatus(task, 'done');
      state.galleryLoaded = false;
    }).catch(function (err) {
      if (!state.signedIn) return;
      if (window.console) console.error(err);
      var message = task.meta ? 'Uploaded, but the share link could not be created. ' + err.message : err.message;
      setTaskStatus(task, 'error', message);
    }).finally(function () {
      state.active--;
      if (!state.signedIn) return;
      pumpQueue();
      if (!state.active && !state.queue.length) loadStorage();
    });
  }

  function clearFinished() {
    state.tasks = state.tasks.filter(function (task) {
      if (task.status !== 'done') return true;
      URL.revokeObjectURL(task.preview);
      task.$item.remove();
      return false;
    });
    $('#uploads').prop('hidden', !state.tasks.length);
  }

  /* ---------- gallery ---------- */

  function loadGallery() {
    state.galleryLoading = true;
    $('#gallery-loading').prop('hidden', false);
    $('#gallery-empty').prop('hidden', true);
    $('#refresh-gallery').prop('disabled', true);

    var links = Dbx.listSharedLinks().catch(function (err) {
      handleError(err);
      return {};
    });
    return Promise.all([Dbx.listFiles(), links]).then(function (res) {
      var linkMap = res[1];
      state.images = res[0].filter(function (entry) { return IMAGE_EXT.test(entry.name); }).map(function (entry) {
        return {
          key: entry.path_lower,
          name: entry.name,
          path: entry.path_display,
          size: entry.size,
          date: new Date(entry.server_modified),
          url: linkMap[entry.path_lower] || null
        };
      }).sort(function (a, b) { return b.date - a.date; });
      state.selected.clear();
      state.galleryLoaded = true;
      renderGallery();
    }).catch(function (err) {
      handleError(err);
      if (state.signedIn) showEmpty('Could not load your images', err.message);
    }).finally(function () {
      state.galleryLoading = false;
      $('#gallery-loading').prop('hidden', true);
      $('#refresh-gallery').prop('disabled', false);
    });
  }

  /* Date filters use the jQuery UI datepicker; native date inputs are the fallback
     if jQuery UI failed to load. */

  function hasDatepicker() {
    return !!$.fn.datepicker;
  }

  function getFilterDate(selector) {
    if (hasDatepicker()) return $(selector).datepicker('getDate');
    var value = $(selector).val();
    return value ? new Date(value + 'T00:00:00') : null;
  }

  function initDatePickers() {
    var $from = $('#filter-from');
    var $to = $('#filter-to');
    if (!hasDatepicker()) {
      $from.add($to).attr('type', 'date').prop('readonly', false).removeAttr('placeholder');
      return;
    }
    var options = {
      dateFormat: 'd M yy',
      changeMonth: true,
      changeYear: true,
      showOtherMonths: true,
      selectOtherMonths: true,
      maxDate: 0,
      showAnim: '',
      onSelect: function () { $(this).trigger('change'); }
    };
    $from.datepicker(options);
    $to.datepicker(options);
  }

  // Keep the range valid (from <= to) and show a clear button on filled fields.
  function syncDateFilters() {
    var from = getFilterDate('#filter-from');
    var to = getFilterDate('#filter-to');
    if (hasDatepicker()) {
      $('#filter-to').datepicker('option', 'minDate', from);
      $('#filter-from').datepicker('option', 'maxDate', to || 0);
    } else {
      $('#filter-to').attr('min', $('#filter-from').val() || null);
      $('#filter-from').attr('max', $('#filter-to').val() || null);
    }
    $('.date-clear').each(function () {
      $(this).prop('hidden', !hasDatepicker() || !$('#' + $(this).data('for')).val());
    });
  }

  function readFilters() {
    var from = getFilterDate('#filter-from');
    var to = getFilterDate('#filter-to');
    var time = $('#filter-time').val();
    var range = null;
    if (time === 'custom') {
      var start = $('#filter-time-start').val();
      var end = $('#filter-time-end').val();
      if (start || end) range = [toMinutes(start || '00:00'), toMinutes(end || '23:59')];
    } else if (TIME_PRESETS[time]) {
      range = TIME_PRESETS[time].map(toMinutes);
    }
    return {
      from: from,
      to: to ? new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999) : null,
      range: range
    };
  }

  function hasFilters() {
    var f = readFilters();
    return !!(f.from || f.to || f.range);
  }

  function filteredImages() {
    var f = readFilters();
    return state.images.filter(function (img) {
      if (f.from && img.date < f.from) return false;
      if (f.to && img.date > f.to) return false;
      if (f.range) {
        var m = img.date.getHours() * 60 + img.date.getMinutes();
        var start = f.range[0];
        var end = f.range[1];
        var inRange = start <= end ? m >= start && m <= end : m >= start || m <= end;
        if (!inRange) return false;
      }
      return true;
    });
  }

  function showEmpty(title, sub) {
    var $empty = $('#gallery-empty').prop('hidden', false);
    $empty.find('.empty-title').text(title);
    $empty.find('.empty-sub').text(sub || '');
  }

  function renderGallery() {
    var list = filteredImages();
    var visible = {};
    list.forEach(function (img) { visible[img.key] = true; });
    // Never keep hidden images selected: delete only acts on what the user can see.
    state.selected.forEach(function (key) { if (!visible[key]) state.selected.delete(key); });

    if (thumbObserver) thumbObserver.disconnect();
    state.cards = {};
    var $grid = $('#gallery-grid').empty();
    var fragment = document.createDocumentFragment();
    list.forEach(function (img) {
      var $card = buildCard(img);
      state.cards[img.key] = $card;
      fragment.appendChild($card[0]);
    });
    $grid[0].appendChild(fragment);
    list.forEach(function (img) {
      if (!state.thumbs[img.key] && canThumb(img)) observeThumb(state.cards[img.key][0], img.key);
    });

    var total = state.images.length;
    $('#gallery-count').text(total
      ? (list.length === total ? plural(total, 'image') : 'Showing ' + list.length + ' of ' + plural(total, 'image'))
      : '');
    $('#gallery-empty').prop('hidden', true);
    if (!total) showEmpty('No images yet', 'Paste a screenshot or drop an image on the Upload page and it will show up here.');
    else if (!list.length) showEmpty('No images match these filters', 'Try a wider date range or a different time of day.');
    updateSelectionUI();
  }

  function canThumb(img) {
    return THUMB_EXT.test(img.name) && img.size <= THUMB_MAX_BYTES;
  }

  function buildCard(img) {
    var $card = fromTemplate('tpl-card');
    var selected = state.selected.has(img.key);
    $card.attr('data-key', img.key).toggleClass('selected', selected);
    $card.find('.card-check input').prop('checked', selected).attr('aria-label', 'Select ' + img.name);
    $card.find('.card-thumb').attr('aria-label', 'Preview ' + img.name);
    $card.find('.card-thumb img').attr('alt', img.name);
    $card.find('.card-name').text(img.name).attr('title', img.path);
    $card.find('.card-date').text(formatDate(img.date) + ' · ' + formatTime(img.date)).attr('datetime', img.date.toISOString());
    if (state.thumbs[img.key]) $card.find('.card-thumb img').attr('src', state.thumbs[img.key]);
    else if (canThumb(img)) $card.find('.card-thumb').addClass('loading');
    else $card.find('.card-thumb').addClass('no-thumb');
    setCardLink($card, img.url);
    return $card;
  }

  function setCardLink($card, url) {
    $card.find('.link-row').prop('hidden', !url).find('.link-input').val(url || '');
    $card.find('.btn-create-link').prop('hidden', !!url);
  }

  function findImage(key) {
    for (var i = 0; i < state.images.length; i++) if (state.images[i].key === key) return state.images[i];
    return null;
  }

  /* Thumbnails load lazily as cards scroll into view, in batches of 25. */

  var thumbQueue = [];
  var thumbTimer = null;
  var thumbObserver = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      thumbObserver.unobserve(entry.target);
      requestThumb(entry.target.getAttribute('data-key'));
    });
  }, { rootMargin: '400px 0px' }) : null;

  function observeThumb(el, key) {
    if (thumbObserver) thumbObserver.observe(el);
    else requestThumb(key);
  }

  function requestThumb(key) {
    if (thumbQueue.indexOf(key) === -1) thumbQueue.push(key);
    if (!thumbTimer) thumbTimer = setTimeout(flushThumbs, 50);
  }

  function flushThumbs() {
    thumbTimer = null;
    while (thumbQueue.length) fetchThumbBatch(thumbQueue.splice(0, THUMB_BATCH));
  }

  function fetchThumbBatch(keys) {
    Dbx.getThumbnails(keys).then(function (entries) {
      entries.forEach(function (entry, i) {
        var key = keys[i];
        var $thumb = state.cards[key] ? state.cards[key].find('.card-thumb').removeClass('loading') : $();
        if (entry['.tag'] === 'success') {
          state.thumbs[key] = 'data:image/jpeg;base64,' + entry.thumbnail;
          $thumb.find('img').attr('src', state.thumbs[key]);
        } else {
          $thumb.addClass('no-thumb');
        }
      });
    }).catch(function (err) {
      keys.forEach(function (key) {
        if (state.cards[key]) state.cards[key].find('.card-thumb').removeClass('loading').addClass('no-thumb');
      });
      if (!err.authExpired && window.console) console.warn('Thumbnails failed:', err);
    });
  }

  /* ---------- selection & delete ---------- */

  function updateSelectionUI() {
    var visibleCount = Object.keys(state.cards).length;
    var n = state.selected.size;
    var all = visibleCount > 0 && n === visibleCount;
    $('#selection-count').text(n ? n + ' selected' : '');
    $('#delete-selected').prop('disabled', !n).text(n ? 'Delete selected (' + n + ')' : 'Delete selected');
    $('#select-all').prop({ checked: all, indeterminate: n > 0 && !all, disabled: !visibleCount });
  }

  function toggleSelected(key, on) {
    if (on) state.selected.add(key); else state.selected.delete(key);
    if (state.cards[key]) {
      state.cards[key].toggleClass('selected', on).find('.card-check input').prop('checked', on);
    }
  }

  function deleteSelected() {
    var keys = Array.from(state.selected);
    var n = keys.length;
    if (!n) return;
    confirmDialog({
      title: 'Delete ' + plural(n, 'image') + '?',
      message: (n === 1 ? 'This image' : 'These images') + ' will be removed from your Dropbox and ' +
        (n === 1 ? 'its share link' : 'their share links') + ' will stop working. ' +
        'You can restore deleted files from dropbox.com for a limited time.',
      confirmLabel: 'Delete ' + plural(n, 'image')
    }).then(function (ok) {
      if (!ok) return;
      $('#delete-selected').prop('disabled', true).addClass('busy').text('Deleting…');
      return Dbx.deleteFiles(keys).then(function (results) {
        var deleted = {};
        var failed = 0;
        results.forEach(function (r) { if (r.ok) deleted[r.path] = true; else failed++; });
        var count = results.length - failed;
        state.images = state.images.filter(function (img) { return !deleted[img.key]; });
        Object.keys(deleted).forEach(function (key) {
          state.selected.delete(key);
          delete state.thumbs[key];
        });
        renderGallery();
        loadStorage();
        if (count) toast('Deleted ' + plural(count, 'image') + '.', 'success');
        if (failed) toast(plural(failed, 'image') + ' could not be deleted. Please try again.', 'error');
      });
    }).catch(handleError).finally(function () {
      $('#delete-selected').removeClass('busy');
      updateSelectionUI();
    });
  }

  /* ---------- preview ---------- */

  function openPreview(img) {
    var dialog = $('#preview-dialog')[0];
    var $img = $('#preview-img').removeAttr('src').attr('alt', img.name).prop('hidden', true);
    $('#preview-title').text(img.name);
    $('#preview-spinner').prop('hidden', false);
    $('#preview-link').prop('hidden', !img.url).find('.link-input').val(img.url || '');
    if (dialog.showModal) dialog.showModal();
    Dbx.getTemporaryLink(img.key).then(function (link) {
      $img.one('load error', function () { $('#preview-spinner').prop('hidden', true); })
        .attr('src', link).prop('hidden', false);
    }).catch(function (err) {
      $('#preview-spinner').prop('hidden', true);
      if (dialog.open) dialog.close();
      handleError(err);
    });
  }

  /* ---------- event wiring ---------- */

  function detectOS() {
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent;
    if (/Mac|iPhone|iPad|iPod/i.test(platform)) return 'mac';
    if (/Win/i.test(platform)) return 'windows';
    if (/Linux|X11|CrOS/i.test(platform)) return 'linux';
    return 'other';
  }

  // Shortcuts that put a screenshot straight on the clipboard, ready to paste.
  function showScreenshotTip(os) {
    var keys = {
      mac: [['Ctrl', '⇧ Shift', '⌘', '4'], 'copies a selected area'],
      windows: [['⊞ Win', 'Shift', 'S'], 'copies a selected area'],
      linux: [['PrtSc'], 'opens the screenshot tool (choose copy to clipboard)']
    }[os];
    var $tip = $('#screenshot-tip').empty();
    if (!keys) return;
    $tip.append('Tip: ');
    keys[0].forEach(function (key, i) {
      if (i) $tip.append(' + ');
      $tip.append($('<kbd>').text(key));
    });
    $tip.append(' ' + keys[1] + ', then paste it here.');
  }

  function hasFiles(e) {
    var dt = e.originalEvent && e.originalEvent.dataTransfer;
    return !!dt && Array.prototype.indexOf.call(dt.types || [], 'Files') !== -1;
  }

  function bindEvents() {
    var os = detectOS();
    var isMac = os === 'mac';
    $('.paste-key').text(isMac ? '⌘ V' : 'Ctrl V');
    showScreenshotTip(os);

    $(window).on('hashchange', function () {
      if (state.signedIn) route();
      else if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    });

    // Landing-page section links scroll smoothly without adding #section to the URL.
    $(document).on('click', '#view-login a[href^="#"], .topbar .guest-only a[href^="#"]', function (e) {
      var target = document.getElementById(this.getAttribute('href').slice(1));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('.brand').on('click', function (e) {
      if (state.signedIn) return;
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    if (/^#(how-it-works|features|shortcuts|faq)$/.test(window.location.hash)) {
      var section = document.getElementById(window.location.hash.slice(1));
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setTimeout(function () { section.scrollIntoView({ block: 'start' }); }, 0);
    }

    $('.js-login').on('click', function () {
      var $buttons = $('.js-login').prop('disabled', true);
      var $label = $(this).find('.btn-label');
      var label = $label.text();
      $label.text('Redirecting to Dropbox…');
      Dbx.beginLogin().catch(function (err) {
        $buttons.prop('disabled', false);
        $label.text(label);
        handleError(err);
      });
    });
    $('#year').text(new Date().getFullYear());

    $('#logout-btn').on('click', function () {
      var $btn = $(this);
      var busy = state.active || state.queue.length;
      confirmDialog({
        title: 'Log out of ShotShare?',
        message: (busy ? 'Uploads still in progress may not finish. ' : '') +
          'Your images stay in your Dropbox. You will need to sign in with Dropbox again to use the app.',
        confirmLabel: 'Log out'
      }).then(function (ok) {
        if (!ok) return;
        $btn.prop('disabled', true);
        return Dbx.signOut().then(function () {
          leaveApp();
          toast('You have been logged out.', 'info');
        });
      }).finally(function () { $btn.prop('disabled', false); });
    });

    $(document).on('dropbox:signedout', function (e, message) {
      leaveApp();
      toast(message, 'error');
    });

    // Paste screenshots from anywhere on the page.
    $(document).on('paste', function (e) {
      if (!state.signedIn) return;
      var data = e.originalEvent.clipboardData;
      var files = [];
      $.each((data && data.items) || [], function (i, item) {
        if (item.kind === 'file' && /^image\//.test(item.type)) {
          var file = item.getAsFile();
          if (file) files.push(file);
        }
      });
      if (!files.length) return;
      e.preventDefault();
      addFiles(files, true);
    });

    // Drag & drop anywhere on the page.
    var dragDepth = 0;
    var $overlay = $('#drop-overlay');
    $(document).on('dragenter', function (e) {
      if (!hasFiles(e)) return;
      dragDepth++;
      if (state.signedIn) $overlay.addClass('show');
    }).on('dragleave', function (e) {
      if (!hasFiles(e)) return;
      if (--dragDepth <= 0) { dragDepth = 0; $overlay.removeClass('show'); }
    }).on('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.originalEvent.dataTransfer.dropEffect = state.signedIn ? 'copy' : 'none';
    }).on('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      $overlay.removeClass('show');
      addFiles(e.originalEvent.dataTransfer.files, false);
    });

    // File picker.
    $('#dropzone').on('click', function () { $('#file-input').trigger('click'); })
      .on('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file-input').trigger('click'); }
      });
    $('#file-input').on('click', function (e) { e.stopPropagation(); })
      .on('change', function () {
        addFiles(this.files, false);
        this.value = '';
      });

    $('#upload-list').on('click', '.btn-retry', function () {
      var task = $(this).closest('.upload-item').data('task');
      setTaskStatus(task, 'queued');
      enqueue(task);
    });
    $('#clear-finished').on('click', clearFinished);

    // Copy links (upload list, gallery and preview).
    $(document).on('click', '.btn-copy', function () {
      var $btn = $(this);
      var $input = $btn.closest('.link-row').find('.link-input');
      copyText($input.val()).then(function () {
        flashButton($btn, 'Copied!');
      }).catch(function () {
        $input.trigger('focus').trigger('select');
        toast('Press ' + (isMac ? '⌘ C' : 'Ctrl C') + ' to copy the selected link.', 'info');
      });
    });
    $(document).on('focus click', '.link-input', function () { this.select(); });

    // Gallery.
    initDatePickers();
    $('.date-clear').on('click', function () {
      $('#' + $(this).data('for')).val('').trigger('change');
    });
    $('#refresh-gallery').on('click', function () { if (!state.galleryLoading) loadGallery(); });

    $('#filters').on('submit', function (e) { e.preventDefault(); })
      .on('input change', 'input, select', function () {
        $('#custom-time').prop('hidden', $('#filter-time').val() !== 'custom');
        syncDateFilters();
        if (state.galleryLoaded) renderGallery();
      })
      .on('reset', function () {
        // Values are reset after the event fires.
        setTimeout(function () {
          $('#custom-time').prop('hidden', true);
          syncDateFilters();
          if (state.galleryLoaded) renderGallery();
        }, 0);
      });

    $('#gallery-grid').on('change', '.card-check input', function () {
      toggleSelected($(this).closest('.card').attr('data-key'), this.checked);
      updateSelectionUI();
    }).on('click', '.card-thumb', function () {
      var img = findImage($(this).closest('.card').attr('data-key'));
      if (img) openPreview(img);
    }).on('click', '.btn-create-link', function () {
      var $btn = $(this).prop('disabled', true).text('Creating…');
      var $card = $btn.closest('.card');
      var img = findImage($card.attr('data-key'));
      Dbx.createSharedLink(img.key).then(function (url) {
        img.url = url;
        setCardLink($card, url);
      }).catch(handleError).finally(function () {
        $btn.prop('disabled', false).text('Create share link');
      });
    });

    $('#select-all').on('change', function () {
      var on = this.checked;
      Object.keys(state.cards).forEach(function (key) { toggleSelected(key, on); });
      updateSelectionUI();
    });
    $('#delete-selected').on('click', deleteSelected);

    // Preview dialog: close button and backdrop click.
    $('#preview-close').on('click', function () { $('#preview-dialog')[0].close(); });
    $('#preview-dialog').on('click', function (e) { if (e.target === this) this.close(); });

    $(window).on('beforeunload', function () {
      if (state.active || state.queue.length) return 'Uploads are still in progress.';
    });
  }

  /* ---------- start ---------- */

  $(function () {
    // Sign-in state is per origin, so always run on the origin Dropbox redirects back to.
    if (cfg.redirectUri) {
      var home = new URL(cfg.redirectUri);
      if (home.origin !== window.location.origin) {
        window.location.replace(home.origin + home.pathname + window.location.search + window.location.hash);
        return;
      }
    }
    bindEvents();
    showLoginSetup();
    Dbx.handleRedirect().then(function (signedIn) {
      if (signedIn) toast('Signed in to Dropbox.', 'success');
    }).catch(handleError).finally(function () {
      if (Dbx.isSignedIn()) enterApp(); else showView('login');
    });
  });
})(window, jQuery);
