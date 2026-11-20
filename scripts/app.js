(function () {
    'use strict';
    // SESSION & NAVIGATION ------------------------------------------------------
    // Persistent gameplay + navigation, stored in this browser only.
    const KEY = 'houtan.three-doors.v4';
    const ids = ['home', 'about', 'camera', 'game', 'report'];
    const names = { home: 'Home', about: 'Meet Houtan', camera: 'Face & feelings', game: 'Castle game', report: 'Reflection' };
    const $ = id => document.getElementById(id);
    let state = { version: 6, created: Date.now(), screen: 'home', tracking: true, events: [], ms: { home: 0, about: 0, camera: 0, game: 0, report: 0 }, visited: [], selfReport: '', cameraEver: false, game: null };
    let recordingOn = true;
    let lastStart = performance.now(), lastSave = Date.now();
    let storageOK = true;
    function load() { try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
            const d = JSON.parse(raw);
            if (d && (d.version === 4 || d.version === 5 || d.version === 6)) {
                state = { ...state, ...d, ms: { ...state.ms, ...d.ms } };
                recordingOn = state.tracking !== false;
                return true;
            }
        }
    }
    catch (e) {
        storageOK = false;
    } return false; }
    let restored = load();
    if (Object.prototype.hasOwnProperty.call(state, 'faceNote'))
        delete state.faceNote;
    function duration() { if (document.visibilityState !== 'hidden' && recordingOn) {
        state.ms[state.screen] = (state.ms[state.screen] || 0) + Math.max(0, performance.now() - lastStart);
    } lastStart = performance.now(); }
    function save() { if (!storageOK || !recordingOn)
        return; try {
        localStorage.setItem(KEY, JSON.stringify(state));
        lastSave = Date.now();
    }
    catch (e) {
        storageOK = false;
    } }
    function event(name, detail = '') { if (!recordingOn)
        return; state.events.push({ at: Date.now(), name: String(name).slice(0, 70), detail: String(detail).slice(0, 120) }); if (state.events.length > 240)
        state.events = state.events.slice(-240); save(); }
    function elapsed(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
    function totalTime() { return Object.values(state.ms).reduce((a, b) => a + b, 0); }
    function show(id, { silent = false } = {}) { if (!ids.includes(id))
        return; if (id !== 'camera')
        stopCam(); if (id !== state.screen) {
        duration();
        state.screen = id;
        if (!silent)
            event('Opened', names[id]);
        if (id !== 'home' && id !== 'report' && !state.visited.includes(id)) {
            state.visited.push(id);
            event('First visit', names[id]);
        }
    } document.querySelectorAll('.screen').forEach(e => e.classList.toggle('active', e.id === id)); document.querySelectorAll('.topnav button').forEach(b => b.classList.toggle('active', b.dataset.go === id)); if (id === 'report')
        renderReport(); if (id === 'game') {
        paintGame();
    } if (id === 'camera') {
        renderDiagnostics();
    } window.scrollTo({ top: 0, behavior: 'instant' }); save(); }
    document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); show(b.dataset.go); }));
    document.querySelectorAll('details[data-detail]').forEach(d => d.addEventListener('toggle', () => { if (d.open)
        event('Opened detail', d.dataset.detail); }));
    // CAMERA & EXPRESSION LAB -------------------------------------------------
    // Camera and photo expressions: face-api.js with tinyFaceDetector + faceExpressionNet.
    // Library/model weights are requested only after a visitor explicitly starts the lab.
    // No pixels, crops, face descriptors, or inferred expressions enter localStorage.
    const video = $('camVideo'), overlay = $('camOverlay'), photo = $('camPhoto');
    let stream = null, detectLoop = 0, cameraToken = 0, analysing = false, lastDetect = 0, loadedModels = false;
    let activeSource = null, currentVisual = null, photoObjectUrl = null, exprHistory = [], headHistory = [];
    // Ephemeral diagnostic data. Never attach to the persistent `state` object.
    const diagOrder = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];
    let diagSamples = [], diagMarks = [], diagStartedAt = performance.now(), diagLastRaw = null, diagSegment = 0;
    const expEmoji = { neutral: '😐', happy: '😊', sad: '😢', angry: '😠', fearful: '😨', disgusted: '🤢', surprised: '😮' };
    const expNames = { neutral: 'Neutral', happy: 'Happy-looking', sad: 'Sad-looking', angry: 'Angry-looking', fearful: 'Fearful-looking', disgusted: 'Disgusted-looking', surprised: 'Surprised-looking' };
    const MODEL_PATHS = [
        'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights',
        'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights'
    ];
    let modelPromise = null;
    function setCamStatus(s) { $('cameraStatus').textContent = s; }
    function setModelLoading(on, title = '', detail = '') {
        const el = $('modelLoading');
        if (!el)
            return;
        el.classList.toggle('active', !!on);
        $('cameraBox').classList.toggle('busy', !!on);
        if (title)
            $('modelLoadingTitle').textContent = title;
        if (detail)
            $('modelLoadingDetail').textContent = detail;
    }
    function resetEstimate(message = 'No expression estimate yet') {
        if (exprHistory.length)
            diagSegment++;
        currentVisual = null;
        exprHistory = [];
        headHistory = [];
        $('expressionEmoji').textContent = '😐';
        $('expressionName').textContent = message;
        $('expressionCaption').textContent = '';
        $('expressionBars').innerHTML = '';
        $('headPose').textContent = 'Centered';
        $('attentionProxy').textContent = 'Waiting';
        if ($('markAnger'))
            $('markAnger').disabled = !diagLastRaw;
    }
    function avgPoint(points, ids) { const pts = ids.map(i => points[i]).filter(Boolean); const sum = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 }); return { x: sum.x / pts.length, y: sum.y / pts.length }; }
    function estimatePose(result) { const pts = result?.landmarks?.positions; if (!pts || pts.length < 48)
        return { label: 'Centered', attention: 'Unknown', yaw: 0, pitch: 0 }; const L = avgPoint(pts, [36, 37, 38, 39, 40, 41]), R = avgPoint(pts, [42, 43, 44, 45, 46, 47]), nose = pts[30], mouth = pts[62] || pts[66] || pts[57]; const eyeMid = { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 }; const eyeDist = Math.max(1, Math.hypot(R.x - L.x, R.y - L.y)); const yaw = (nose.x - eyeMid.x) / (eyeDist * 0.55); const pitch = mouth ? ((mouth.y - eyeMid.y) / eyeDist) - 0.92 : 0; let horiz = yaw > 0.22 ? 'Right' : yaw < -0.22 ? 'Left' : 'Centered'; let vert = pitch < -0.22 ? ' · Up' : pitch > 0.22 ? ' · Down' : ''; const label = horiz === 'Centered' && !vert ? 'Centered' : horiz + vert; const attention = Math.abs(yaw) < 0.36 && pitch > -0.28 && pitch < 0.42 ? 'Facing screen' : 'Partly turned away'; return { label, attention, yaw, pitch }; }
    function normalizedScores(obj) { const o = {}; for (const k of diagOrder) {
        const v = Number(obj?.[k]);
        o[k] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    } return o; }
    function movingAverage(frames, windowSize) { const subset = frames.slice(-windowSize); const out = {}; for (const k of diagOrder)
        out[k] = subset.length ? subset.reduce((sum, f) => sum + (f[k] || 0), 0) / subset.length : 0; return out; }
    function smoothedExpressions(obj) { const raw = normalizedScores(obj); exprHistory.push(raw); if (exprHistory.length > 24)
        exprHistory.shift(); return movingAverage(exprHistory, Number($('diagSmoothing')?.value || 6)); }
    function clearPhoto() { if (photoObjectUrl) {
        URL.revokeObjectURL(photoObjectUrl);
        photoObjectUrl = null;
    } photo.removeAttribute('src'); photo.classList.add('hide'); $('cameraBox').classList.remove('photo-view'); }
    function stopCam() { cameraToken++; cancelAnimationFrame(detectLoop); detectLoop = 0; if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
        event('Camera', 'Stopped');
    } ; video.srcObject = null; video.classList.add('hide'); overlay.classList.add('hide'); $('camPlaceholder').classList.remove('hide'); $('camTag').innerHTML = '<span class="red"></span>Camera off'; $('startCamera').disabled = false; $('stopCamera').disabled = true; activeSource = null; clearPhoto(); resetEstimate(); }
    function prepareOverlay() { const rc = overlay.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1), ctx = overlay.getContext('2d'); overlay.width = Math.max(1, Math.round(rc.width * dpr)); overlay.height = Math.max(1, Math.round(rc.height * dpr)); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { ctx, w: rc.width, h: rc.height }; }
    function injectFaceApi(url) { return new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = url; s.onload = () => window.faceapi ? resolve() : reject(Error('Library did not initialize')); s.onerror = () => reject(Error('Library unavailable')); document.head.appendChild(s); }); }
    async function ensureEmotionModels() {
        if (loadedModels && window.faceapi)
            return;
        if (modelPromise)
            return modelPromise;
        modelPromise = (async () => {
            setCamStatus('Preparing on-device face analysis…');
            setModelLoading(true, 'Loading face-analysis engine', 'Connection required. Your game and story remain available offline.');
            if (!window.faceapi) {
                for (const u of ['https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js', 'https://unpkg.com/face-api.js@0.22.2/dist/face-api.min.js']) {
                    try {
                        await injectFaceApi(u);
                        break;
                    }
                    catch (e) { }
                }
                if (!window.faceapi)
                    throw Error('Could not load the face-analysis engine. Check the internet connection.');
            }
            let lastErr;
            for (const base of MODEL_PATHS) {
                try {
                    setModelLoading(true, 'Loading model 1 of 3', 'Locating a face in the image…');
                    await window.faceapi.nets.tinyFaceDetector.loadFromUri(base);
                    setModelLoading(true, 'Loading model 2 of 3', 'Finding facial landmarks…');
                    await window.faceapi.nets.faceLandmark68TinyNet.loadFromUri(base);
                    setModelLoading(true, 'Loading model 3 of 3', 'Preparing the expression categories…');
                    await window.faceapi.nets.faceExpressionNet.loadFromUri(base);
                    loadedModels = true;
                    return;
                }
                catch (e) {
                    lastErr = e;
                }
            }
            throw Error('Could not download the models. Try a different connection or return to the other experiences.');
        })();
        try {
            await modelPromise;
        }
        catch (e) {
            modelPromise = null;
            throw e;
        }
        finally {
            setModelLoading(false);
        }
    }
    function showEstimate(result) {
        const raw = normalizedScores(result.expressions || {});
        const smooth = smoothedExpressions(raw);
        const entries = Object.entries(smooth).sort((a, b) => b[1] - a[1]);
        if (!entries.length) {
            resetEstimate('No reliable expression result');
            return;
        }
        const [label, score] = entries[0];
        const pose = estimatePose(result);
        headHistory.push(pose);
        if (headHistory.length > 6)
            headHistory.shift();
        const avgYaw = headHistory.reduce((a, p) => a + p.yaw, 0) / headHistory.length;
        const avgPitch = headHistory.reduce((a, p) => a + p.pitch, 0) / headHistory.length;
        const poseLabel = Math.abs(avgYaw) < 0.22 && Math.abs(avgPitch) < 0.22 ? 'Centered' : (avgYaw > 0.22 ? 'Right' : avgYaw < -0.22 ? 'Left' : 'Centered') + (avgPitch < -0.22 ? ' · Up' : avgPitch > 0.22 ? ' · Down' : '');
        const attention = Math.abs(avgYaw) < 0.36 && avgPitch > -0.28 && avgPitch < 0.42 ? 'Facing screen' : 'Partly turned away';
        currentVisual = { label, score, pose: poseLabel, attention };
        $('expressionEmoji').textContent = expEmoji[label];
        $('expressionName').textContent = expNames[label] + ' expression';
        $('expressionCaption').textContent = '';
        $('expressionBars').innerHTML = entries.slice(0, 3).map(([k, v]) => '<div class="expression-bar"><span>' + expEmoji[k] + ' ' + expNames[k] + '</span><span class="rail"><span class="barfill" style="display:block;width:' + Math.round(v * 100) + '%"></span></span><b>' + Math.round(v * 100) + '%</b></div>').join('');
        $('headPose').textContent = poseLabel;
        $('attentionProxy').textContent = attention;
        addDiagnosticSample(raw, activeSource === 'photo' ? 'photo' : 'camera');
        updateSelfReport();
    }
    // A local visual audit of classifier outputs, not emotion inference.
    function bestLabel(scores) { return diagOrder.reduce((best, k) => scores[k] > scores[best] ? k : best, diagOrder[0]); }
    function scoreText(k, v) { return expEmoji[k] + ' ' + expNames[k] + ' · ' + Math.round(v * 100) + '%'; }
    function addDiagnosticSample(raw, source) {
        const time = performance.now() - diagStartedAt;
        const sample = { t_ms: Math.round(time), segment: diagSegment, source, raw: normalizedScores(raw) };
        diagSamples.push(sample);
        if (diagSamples.length > 360)
            diagSamples.shift();
        diagLastRaw = sample;
        $('markAnger').disabled = false;
        $('downloadDiagnostics').disabled = false;
        renderDiagnostics();
    }
    function diagnosticSmooth(index, n) { const seg = diagSamples[index]?.segment; const history = []; for (let j = index; j >= 0 && history.length < n; j--) {
        if (diagSamples[j].segment !== seg)
            break;
        history.unshift(diagSamples[j].raw);
    } return movingAverage(history, n); }
    function renderDiagnostics() {
        const count = diagSamples.length;
        $('diagSampleCount').textContent = count;
        if (!count) {
            $('diagRawTop').textContent = 'Awaiting image';
            $('diagSmoothTop').textContent = 'Awaiting image';
            $('diagScores').innerHTML = '<p class="minor">Start the camera or try a photo to see the seven outputs.</p>';
            $('angerStats').textContent = 'No readings yet. No diagnostic samples have been collected.';
            $('downloadDiagnostics').disabled = true;
            $('markAnger').disabled = true;
            drawAngerChart();
            return;
        }
        const win = Number($('diagSmoothing').value);
        const raw = diagSamples[count - 1].raw;
        const smooth = diagnosticSmooth(count - 1, win);
        const rawLabel = bestLabel(raw), smLabel = bestLabel(smooth);
        $('diagRawTop').textContent = scoreText(rawLabel, raw[rawLabel]);
        $('diagSmoothTop').textContent = scoreText(smLabel, smooth[smLabel]);
        $('diagScores').innerHTML = diagOrder.map(k => {
            const rv = Math.round(raw[k] * 100), sv = Math.round(smooth[k] * 100);
            return '<div class="diagrow' + (k === 'angry' ? ' anger-row' : '') + '"><span>' + expEmoji[k] + ' ' + expNames[k] + '</span><span class="diagside"><span class="meter"><i style="width:' + rv + '%"></i></span><b>' + rv + '%</b></span><span class="diagside is-smooth"><span class="meter"><i style="width:' + sv + '%"></i></span><b>' + sv + '%</b></span></div>';
        }).join('');
        $('angerStats').textContent = 'Latest angry-looking score: ' + Math.round(raw.angry * 100) + '% raw / ' + Math.round(smooth.angry * 100) + '% smoothed. These values are classifier outputs, not calibrated probabilities.';
        drawAngerChart();
    }
    function drawAngerChart() {
        const chart = $('angerChart');
        if (!chart)
            return;
        const cx = chart.getContext('2d'), w = chart.width, h = chart.height, p = { l: 38, r: 17, t: 17, b: 27 };
        const ww = w - p.l - p.r, hh = h - p.t - p.b;
        cx.clearRect(0, 0, w, h);
        cx.fillStyle = '#fff';
        cx.fillRect(0, 0, w, h);
        cx.font = '12px system-ui, sans-serif';
        cx.textBaseline = 'middle';
        cx.strokeStyle = '#e6e9e0';
        cx.fillStyle = '#718276';
        cx.lineWidth = 1;
        for (let v = 0; v <= 100; v += 25) {
            const y = p.t + hh * (1 - v / 100);
            cx.beginPath();
            cx.moveTo(p.l, y);
            cx.lineTo(w - p.r, y);
            cx.stroke();
            cx.textAlign = 'right';
            cx.fillText(v + '%', p.l - 8, y);
        }
        const rows = diagSamples.slice(-55);
        if (!rows.length) {
            cx.fillStyle = '#88998b';
            cx.textAlign = 'center';
            cx.fillText('Waiting for a face or photo', p.l + ww / 2, p.t + hh / 2);
            return;
        }
        const frameStart = diagSamples.length - rows.length, n = Number($('diagSmoothing')?.value || 6);
        const px = i => p.l + (rows.length === 1 ? ww / 2 : i / (rows.length - 1) * ww);
        const py = value => p.t + hh * (1 - Math.min(1, Math.max(0, value)));
        function line(color, getVal) { cx.beginPath(); cx.strokeStyle = color; cx.lineWidth = 3; cx.lineJoin = 'round'; rows.forEach((r, i) => { const y = py(getVal(r, i)); if (i === 0 || (i > 0 && rows[i - 1].segment !== r.segment))
            cx.moveTo(px(i), y);
        else
            cx.lineTo(px(i), y); }); if (rows.length > 1)
            cx.stroke(); for (let i = 0; i < rows.length; i++) {
            if (rows.length <= 2 || i === rows.length - 1) {
                cx.beginPath();
                cx.arc(px(i), py(getVal(rows[i], i)), 4, 0, Math.PI * 2);
                cx.fillStyle = color;
                cx.fill();
            }
        } }
        line('#c9805d', r => r.raw.angry);
        line('#3e8c73', (r, i) => diagnosticSmooth(frameStart + i, n).angry);
        diagMarks.forEach(mark => { const i = rows.findIndex(r => r.t_ms >= mark.t_ms); if (i < 0)
            return; const x = px(i); cx.setLineDash([4, 5]); cx.strokeStyle = '#9a826c'; cx.lineWidth = 1.5; cx.beginPath(); cx.moveTo(x, p.t); cx.lineTo(x, p.t + hh); cx.stroke(); cx.setLineDash([]); });
        cx.textAlign = 'left';
        cx.fillStyle = '#718276';
        cx.fillText('Earlier', p.l, p.t + hh + 16);
        cx.textAlign = 'right';
        cx.fillText('Latest', w - p.r, p.t + hh + 16);
    }
    $('diagSmoothing').addEventListener('change', () => {
        if (exprHistory.length) {
            const smooth = movingAverage(exprHistory, Number($('diagSmoothing').value)), top = bestLabel(smooth);
            if (currentVisual) {
                currentVisual.label = top;
                currentVisual.score = smooth[top];
                $('expressionEmoji').textContent = expEmoji[top];
                $('expressionName').textContent = expNames[top] + ' expression';
                $('expressionCaption').textContent = '';
            }
        }
        renderDiagnostics();
    });
    $('markAnger').addEventListener('click', () => {
        if (!diagLastRaw || !$('angerIntent').checked) {
            $('diagMarkStatus').textContent = 'Tick the deliberate-expression box before marking.';
            return;
        }
        const win = Number($('diagSmoothing').value), sm = diagnosticSmooth(diagSamples.length - 1, win);
        diagMarks.push({ t_ms: diagLastRaw.t_ms, source: diagLastRaw.source, label: 'deliberately angry-looking', raw_anger: Number(diagLastRaw.raw.angry.toFixed(4)), smoothed_anger: Number(sm.angry.toFixed(4)) });
        if (diagMarks.length > 30)
            diagMarks.shift();
        $('diagMarkStatus').textContent = 'Test moment ' + diagMarks.length + ' marked. This is an intentional pose, not verified emotion.';
        drawAngerChart();
    });
    $('clearDiagnostics').addEventListener('click', () => {
        diagSamples = [];
        diagMarks = [];
        diagLastRaw = null;
        diagStartedAt = performance.now();
        diagSegment = 0;
        exprHistory = [];
        headHistory = [];
        $('diagMarkStatus').textContent = 'Diagnostic samples cleared from this tab.';
        $('angerIntent').checked = false;
        renderDiagnostics();
    });
    $('downloadDiagnostics').addEventListener('click', () => {
        if (!diagSamples.length)
            return;
        const win = Number($('diagSmoothing').value);
        const payload = { schema: 'houtan.expression-diagnostics.v1', note: 'Facial expression classifier scores, not ground-truth emotion.', face_model: 'face-api.js 0.22.2 (TinyFaceDetector, FaceLandmark68TinyNet, FaceExpressionNet)', smoothing_window: win,
            privacy: { image_pixels_included: false, video_included: false, identity_included: false, absolute_timestamps_included: false, notes_saved_to_localStorage: false },
            samples: diagSamples.map((x, i) => ({ elapsed_ms: x.t_ms, source: x.source, raw: x.raw, smoothed: diagnosticSmooth(i, win) })),
            voluntary_test_marks: diagMarks.map(x => ({ ...x })) };
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'houtan_expression_diagnostics.json';
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        $('diagMarkStatus').textContent = 'De-identified numeric report exported. No image or video included. Do not share it publicly without considering privacy.';
    });
    window.addEventListener('resize', () => { if (state.screen === 'camera')
        drawAngerChart(); });
    function drawPrediction(result, source, mirror) {
        const { ctx, w, h } = prepareOverlay();
        ctx.clearRect(0, 0, w, h);
        if (!result)
            return;
        const box = result.detection.box;
        const vw = source.videoWidth || source.naturalWidth || source.width, vh = source.videoHeight || source.naturalHeight || source.height;
        if (!vw || !vh)
            return;
        const scale = mirror ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
        const ox = (w - vw * scale) / 2, oy = (h - vh * scale) / 2;
        let x = ox + box.x * scale, y = oy + box.y * scale, bw = box.width * scale, bh = box.height * scale;
        if (mirror)
            x = w - (x + bw);
        const label = currentVisual?.label || 'neutral';
        ctx.strokeStyle = '#ffdf99';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([9, 6]);
        ctx.strokeRect(x, y, bw, bh);
        ctx.setLineDash([]);
        ctx.font = '34px "Apple Color Emoji","Segoe UI Emoji",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(expEmoji[label], Math.max(28, Math.min(w - 28, x + bw / 2)), Math.max(40, y - 7));
    }
    async function classifyFrame(source, mirror = false) {
        if (!window.faceapi || !loadedModels)
            return;
        const option = new window.faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: .28 });
        const result = await window.faceapi.detectSingleFace(source, option).withFaceLandmarks(true).withFaceExpressions();
        if (!result) {
            resetEstimate('No face detected');
            const { ctx, w, h } = prepareOverlay();
            ctx.clearRect(0, 0, w, h);
            $('camTag').textContent = 'No face detected · move closer or improve lighting';
            return;
        }
        showEstimate(result);
        drawPrediction(result, source, mirror);
        $('camTag').textContent = expEmoji[currentVisual?.label || 'neutral'] + ' Expression estimate · on-device';
    }
    async function faceLoop(t) {
        if (!stream || activeSource !== 'camera' || state.screen !== 'camera')
            return;
        detectLoop = requestAnimationFrame(faceLoop);
        if (!video.videoWidth || analysing || t - lastDetect < 650)
            return;
        lastDetect = t;
        analysing = true;
        const token = cameraToken;
        try {
            await classifyFrame(video, true);
        }
        catch (e) {
            if (token === cameraToken)
                setCamStatus('Inference failed on this browser. Try a photo instead.');
        }
        finally {
            analysing = false;
        }
    }
    $('startCamera').addEventListener('click', async () => {
        if (!navigator.mediaDevices?.getUserMedia) {
            setCamStatus('Camera unavailable in this browser or local-file mode. Choose a photo instead.');
            return;
        }
        stopCam();
        const token = cameraToken;
        $('startCamera').disabled = true;
        setModelLoading(true, 'Waiting for camera permission', 'Nothing is recorded before you allow access.');
        try {
            // Ask browser permission first. This makes opting into the webcam explicit.
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
            if (token !== cameraToken) {
                stream.getTracks().forEach(t => t.stop());
                stream = null;
                return;
            }
            video.srcObject = stream;
            await video.play();
            video.classList.remove('hide');
            overlay.classList.remove('hide');
            $('camPlaceholder').classList.add('hide');
            $('stopCamera').disabled = false;
            activeSource = 'camera';
            state.cameraEver = true;
            event('Camera', 'Started live preview');
            save();
            await ensureEmotionModels();
            if (token !== cameraToken || !stream)
                return;
            setModelLoading(false);
            setCamStatus('Live expression estimates are analyzed on this device. Camera frames are not saved.');
            detectLoop = requestAnimationFrame(faceLoop);
        }
        catch (e) {
            if (token === cameraToken) {
                setCamStatus(e?.name === 'NotAllowedError' ? 'Camera permission declined. Try uploading a photo instead.' : (e?.message || 'Could not open the camera. Try a photo instead.'));
                $('startCamera').disabled = false;
                setModelLoading(false);
            }
        }
    });
    $('stopCamera').addEventListener('click', stopCam);
    $('photoFile').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file)
            return;
        if (!file.type.startsWith('image/')) {
            setCamStatus('Please choose an image file.');
            return;
        }
        stopCam();
        const token = cameraToken;
        photoObjectUrl = URL.createObjectURL(file);
        photo.src = photoObjectUrl;
        photo.classList.remove('hide');
        $('cameraBox').classList.add('photo-view');
        $('camPlaceholder').classList.add('hide');
        overlay.classList.remove('hide');
        activeSource = 'photo';
        $('camTag').textContent = 'Photo · local processing';
        setCamStatus('Preparing your photo…');
        setModelLoading(true, 'Reading your photo', 'Checking image format and dimensions…');
        try {
            await new Promise((resolve, reject) => { if (photo.complete && photo.naturalWidth)
                return resolve(); photo.onload = resolve; photo.onerror = () => reject(Error('Cannot decode this image')); });
            await ensureEmotionModels();
            if (token !== cameraToken || activeSource !== 'photo')
                return;
            setModelLoading(true, 'Analyzing expression', 'Locating face and estimating visible expression…');
            await classifyFrame(photo, false);
            setCamStatus('Photo analyzed in the browser. Image pixels are not stored or uploaded by this page.');
            event('Facial experiment', 'Photo analyzed. Image and expression result not recorded');
        }
        catch (err) {
            if (token === cameraToken)
                setCamStatus(err?.message || 'Could not analyze photo. Try another image.');
        }
        setModelLoading(false);
        e.target.value = '';
    });
    function updateSelfReport() {
        if (!state.selfReport)
            return;
        const v = '<strong>Your own report: ' + safe(state.selfReport) + '.</strong>';
        const c = currentVisual ? '<br>Expression guess: ' + safe(expNames[currentVisual.label]).toLowerCase() + '.' : '<br>No expression guess yet.';
        $('emotionObservation').innerHTML = v + c;
    }
    document.querySelectorAll('[data-feel]').forEach(b => b.addEventListener('click', () => { state.selfReport = b.dataset.feel; document.querySelectorAll('[data-feel]').forEach(x => x.classList.toggle('active', x === b)); updateSelfReport(); event('Self-report', state.selfReport); save(); }));
    function safe(s) { return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
    // Inline SVG remains a graceful fallback; local miniatures are the default.
    // GAME ART -----------------------------------------------------------------
    // Keep these vector fallbacks so gameplay remains available if a local image fails.
    const DEFENSE_ART = {
        castle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 246">
  <!-- Miniature fortress, with pointed slate roofs and a real arched gate.
       Edit this one illustration to change BOTH the map and home artwork. -->
  <ellipse cx="111" cy="230" rx="104" ry="11" fill="#1f2231" opacity=".18"/>
  <!-- Rear courtyard wall. -->
  <path d="M33 112h155v104H33z" fill="#f6e3b9" stroke="#282737" stroke-width="6" stroke-linejoin="round"/>
  <path d="M49 125h121M49 144h121M49 164h121M49 184h121" stroke="#c4a884" stroke-width="2" stroke-dasharray="15 14" opacity=".65"/>
  <!-- Main keep, behind the front turrets. -->
  <path d="M75 101h69v114H75z" fill="#f9e8c7" stroke="#282737" stroke-width="6"/>
  <path d="M64 106 110 31 156 106Z" fill="#ff8f7b" stroke="#282737" stroke-width="7" stroke-linejoin="round"/>
  <path d="M102 39 75 95h15l20-32 20 32h14z" fill="#ffcf66" opacity=".75"/>
  <path d="M110 33V9" stroke="#282737" stroke-width="5" stroke-linecap="round"/>
  <path d="M112 10h28l-8 11 8 11h-28z" fill="#ffd45d" stroke="#282737" stroke-width="4" stroke-linejoin="round"/>
  <!-- Left side turret and pointed roof. -->
  <path d="M12 98h62v119H12z" fill="#e1d4fa" stroke="#282737" stroke-width="6"/>
  <path d="M4 101 43 24 82 101Z" fill="#a794fa" stroke="#282737" stroke-width="7" stroke-linejoin="round"/>
  <path d="M25 87 43 52 61 87" fill="none" stroke="#e6dfff" stroke-width="4" stroke-linecap="round"/>
  <path d="M34 119q9-14 18 0v25H34z" fill="#37405c" stroke="#282737" stroke-width="4"/>
  <path d="M34 166q9-14 18 0v25H34z" fill="#37405c" stroke="#282737" stroke-width="4"/>
  <!-- Right turret, symmetric but not identical. -->
  <path d="M147 98h62v119h-62z" fill="#bde9df" stroke="#282737" stroke-width="6"/>
  <path d="M139 101 178 24 217 101Z" fill="#49b9aa" stroke="#282737" stroke-width="7" stroke-linejoin="round"/>
  <path d="M160 87 178 52 196 87" fill="none" stroke="#aff8e4" stroke-width="4" stroke-linecap="round"/>
  <path d="M169 119q9-14 18 0v25h-18z" fill="#37405c" stroke="#282737" stroke-width="4"/>
  <path d="M169 166q9-14 18 0v25h-18z" fill="#37405c" stroke="#282737" stroke-width="4"/>
  <!-- Brick-band accent + heavy foundation. -->
  <path d="M9 213h204v12H9z" fill="#d7a766" stroke="#282737" stroke-width="5"/>
  <!-- Big pointed-arch doorway that lines up with the map road. -->
  <path d="M84 218v-47q0-21 26-36 26 15 26 36v47Z" fill="#2b3043" stroke="#282737" stroke-width="6" stroke-linejoin="round"/>
  <path d="M110 143v75" stroke="#a2784c" stroke-width="4"/>
  <circle cx="123" cy="191" r="4" fill="#ffd45d"/>
</svg>`,
        spark: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 104 116"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ede5ff"/><stop offset=".57" stop-color="#9279c7"/><stop offset="1" stop-color="#534779"/></linearGradient><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#d5c29f"/><stop offset="1" stop-color="#877354"/></linearGradient></defs><ellipse cx="52" cy="102" rx="37" ry="9" fill="#34462d" opacity=".2"/><path d="M24 82h56l8 19H16z" fill="url(#b)" stroke="#5e5948" stroke-width="4" stroke-linejoin="round"/><path d="M29 80h46v-9H29z" fill="#f0d8a7" stroke="#705f4b" stroke-width="3"/><path d="M53 10 77 45 60 73 47 76 28 47z" fill="url(#a)" stroke="#51446f" stroke-width="4" stroke-linejoin="round"/><path d="m53 10 6 66-12 0-19-29z" fill="#f2e9ff" opacity=".68"/><path d="m53 10 24 35-17 28z" fill="#755db3" opacity=".9"/><path d="M41 41 53 18 61 42" fill="none" stroke="#fff8e5" stroke-width="3" stroke-linecap="round"/><path d="m26 18 3-9m5 14 8-4M82 25l8-3M15 53l-7 4M83 60l10 3" stroke="#f6c970" stroke-width="4" stroke-linecap="round"/><circle cx="86" cy="40" r="4" fill="#ffe5a1"/><circle cx="15" cy="26" r="3" fill="#fff2b4"/></svg>`,
        compass: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 104 116"><defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#cba77a"/><stop offset="1" stop-color="#7d644b"/></linearGradient></defs><ellipse cx="52" cy="104" rx="40" ry="9" fill="#374939" opacity=".18"/><path d="M22 79h60l7 23H15z" fill="#9b8768" stroke="#5a564d" stroke-width="4" stroke-linejoin="round"/><path d="M32 35h40v51H32z" fill="url(#t)" stroke="#594b42" stroke-width="4"/><path d="M28 39v-10l23-15 25 15v10z" fill="#587b6b" stroke="#3b5b51" stroke-width="4" stroke-linejoin="round"/><path d="M36 37v-8h9v8m12 0v-8h9v8" fill="#d7e7b9"/><path d="M39 54h26v14H39z" fill="#293f4d" stroke="#d7c59c" stroke-width="3"/><path d="M46 67v-11m11 11V56" stroke="#baa987" stroke-width="3"/><path d="M58 50 84 30M58 50 90 54" stroke="#aa6c41" stroke-width="5" stroke-linecap="round"/><path d="M83 31q-14 12 1 23" fill="none" stroke="#f5dfaa" stroke-width="4"/><path d="M46 64l8-8 6 8z" fill="#dcead4"/><path d="M52 14V5l14 5-14 5" fill="#d9826a" stroke="#9b5e4c" stroke-width="2"/><path d="M52 15v16" stroke="#4b5b48" stroke-width="3"/></svg>`,
        lantern: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 104 116"><defs><radialGradient id="glow"><stop stop-color="#fff5b3"/><stop offset=".63" stop-color="#ffd477"/><stop offset="1" stop-color="#f2a363"/></radialGradient></defs><ellipse cx="52" cy="101" rx="37" ry="9" fill="#404a2f" opacity=".18"/><path d="M26 80h52l9 21H17z" fill="#9c8a6c" stroke="#565044" stroke-width="4" stroke-linejoin="round"/><path d="M47 27h10v52H47z" fill="#775b47" stroke="#604939" stroke-width="3"/><path d="M33 27h38l-5 45H38z" fill="#536758" stroke="#355144" stroke-width="4" stroke-linejoin="round"/><path d="M40 34h24l-3 30H43z" fill="url(#glow)" stroke="#e4b66c" stroke-width="2"/><path d="M52 33v32m-10-31 20 30m0-30-20 30" stroke="#ebbd78" stroke-width="1.8"/><path d="M29 27q23-26 46 0" fill="#476a59" stroke="#375a49" stroke-width="4"/><path d="M44 17q8-11 16 0" fill="none" stroke="#785b44" stroke-width="4"/><circle cx="22" cy="38" r="3" fill="#f9d47e"/><circle cx="81" cy="48" r="4" fill="#f2cc83"/><circle cx="20" cy="61" r="2" fill="#f9dfa4"/></svg>`,
        scout: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 92 104"><defs><linearGradient id="body" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d0a58a"/><stop offset="1" stop-color="#a96b65"/></linearGradient></defs><ellipse cx="45" cy="96" rx="30" ry="7" fill="#223c32" opacity=".24"/><path d="M20 68 9 86 32 84 37 65M58 67l21 14-21 5-8-18" fill="#786055" stroke="#5b4c47" stroke-width="4"/><path d="M24 56q-15-19-5-38l14 10Q44 9 54 27l15-12q13 26 0 43l4 18-17 12H34L18 75z" fill="url(#body)" stroke="#704f4d" stroke-width="4" stroke-linejoin="round"/><path d="M27 48q11-8 23 0M51 48q7-8 17-2" stroke="#704d47" stroke-width="3" fill="none"/><circle cx="37" cy="52" r="4.5" fill="#f7f0da"/><circle cx="58" cy="52" r="4.5" fill="#f7f0da"/><circle cx="38" cy="53" r="2" fill="#303e42"/><circle cx="58" cy="53" r="2" fill="#303e42"/><path d="m41 66 6 5 7-5" stroke="#714d4a" stroke-width="3" fill="none"/><path d="m28 16 5-9 8 13" fill="#b37c6a" stroke="#704f4d" stroke-width="3"/></svg>`,
        brute: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 92 104"><defs><linearGradient id="body" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8eabc1"/><stop offset="1" stop-color="#59728d"/></linearGradient></defs><ellipse cx="45" cy="96" rx="31" ry="7" fill="#223c32" opacity=".24"/><path d="M22 63 9 84 28 89 34 71M59 72l13 17 13-12-19-15" fill="#476579" stroke="#355064" stroke-width="4"/><path d="M26 28Q29 9 47 12q28 1 24 24l6 33-24 16H31L17 68z" fill="url(#body)" stroke="#42596e" stroke-width="4"/><path d="M26 28 10 16l5 28M66 27l15-14 4 29" fill="#88a6b4" stroke="#42596e" stroke-width="4" stroke-linejoin="round"/><path d="M28 48h14m10 0h14" stroke="#3b4e5a" stroke-width="4" stroke-linecap="round"/><circle cx="34" cy="51" r="3" fill="#fae19f"/><circle cx="61" cy="51" r="3" fill="#fae19f"/><path d="M42 68h13" stroke="#d9decf" stroke-width="4" stroke-linecap="round"/></svg>`
    };
    const GAME_ASSET_FILES = {
        castle: 'assets/castle-mini.webp',
        spark: 'assets/tower-spark.webp',
        compass: 'assets/tower-compass.webp',
        lantern: 'assets/tower-lantern.webp',
        scout: 'assets/enemy-scout.webp',
        brute: 'assets/enemy-brute.webp'
    };
    const gameArt = {};
    let gameArtReady = false, gameArtPromise = null;
    const imageUri = svg => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    async function loadGameArt() {
        if (gameArtPromise)
            return gameArtPromise;
        gameArtPromise = (async () => {
            let decoded = 0;
            const total = Object.keys(DEFENSE_ART).length;
            const loading = $('gameAssetLoader'), label = $('gameReadyText');
            if (loading)
                loading.classList.add('active');
            if (label)
                label.textContent = 'Preparing illustrations…';
            await Promise.all(Object.entries(DEFENSE_ART).map(async ([name, svg]) => {
                const image = new Image();
                image.src = GAME_ASSET_FILES[name] || imageUri(svg);
                gameArt[name] = image;
                try {
                    await image.decode();
                }
                catch (e) {
                    await new Promise(resolve => { image.onload = resolve; image.onerror = resolve; setTimeout(resolve, 1500); });
                }
                decoded++;
                if (label)
                    label.textContent = decoded + '/' + total + ' illustrations ready';
                document.querySelectorAll('[data-sprite="' + name + '"]').forEach(el => el.src = image.src);
            }));
            gameArtReady = true;
            if (loading)
                loading.classList.remove('active');
            if (label)
                label.textContent = 'Illustrations ready · works offline';
            if (game)
                paintGame();
        })();
        return gameArtPromise;
    }
    let toastTimer = 0;
    function notify(message, tone = 'info') {
        const el = $('globalToast');
        if (!el)
            return;
        clearTimeout(toastTimer);
        el.textContent = message;
        el.className = 'global-toast show ' + (tone === 'warn' ? 'warn' : '');
        toastTimer = setTimeout(() => { el.classList.remove('show'); }, 2800);
    }
    let hoveredSlot = -1, hasChosenTower = false;
    function updateGuide() {
        if (!game)
            return;
        const phase = game.ended ? 3 : game.wave > 0 ? 3 : game.towers.length > 0 ? 2 : hasChosenTower ? 1 : 0;
        [['guideChoose', 0], ['guidePlace', 1], ['guideDefend', 2]].forEach(([id, i]) => { const el = $(id); if (!el)
            return; el.classList.toggle('done', i < phase); el.classList.toggle('current', i === phase); });
        const tip = game.ended ? 'Round finished · View your observations below' : game.selected ? ('Tap a numbered build pad to place ' + (game.selected === 'spark' ? 'Spark crystal' : game.selected === 'compass' ? 'Archer lookout' : 'Glow lantern')) : '① Choose a defense in the shop';
        $('mapTip').textContent = tip;
        $('startWave').textContent = game.active ? 'Wave in progress…' : game.wave === 1 ? 'Start wave 2' : 'Start wave 1';
        $('startWave').disabled = game.active || game.ended || game.wave >= 2;
        $('startWaveMobile').textContent = $('startWave').textContent;
        $('startWaveMobile').disabled = $('startWave').disabled;
        document.querySelectorAll('[data-tower]').forEach(b => {
            const type = b.dataset.tower, affordable = game.money >= info[type].cost;
            b.classList.toggle('unaffordable', !affordable);
            b.classList.toggle('active', game.selected === type);
            b.setAttribute('aria-pressed', String(game.selected === type));
            b.title = affordable ? 'Select ' + type + ' defense' : 'Need ' + (info[type].cost - game.money) + ' more coins';
        });
        document.querySelectorAll('#padControls button').forEach((b, i) => { const occupied = game.towers.some(t => t.slot === i); b.classList.toggle('occupied', occupied); b.title = occupied ? 'Pad ' + (i + 1) + ' already occupied' : 'Place defense on pad ' + (i + 1); });
    }
    function showCoinShortage(cost) { const shortage = cost - game.money; notify('Not enough coins. You need ' + shortage + ' more. Defeat enemies to earn coins.', 'warn'); const badge = $('coinBadge'); badge.classList.remove('coin-flash'); void badge.offsetWidth; badge.classList.add('coin-flash'); }
    // Mini tower defense game: illustrated canvas, guided placement, and event logging.
    const canvas = $('arena'), ctx = canvas.getContext('2d'), W = 900, H = 465;
    // End at the castle gate so enemies visibly reach their target rather than
    // walking through the keep and disappearing beyond the edge of the map.
    const pts = [[0, 218], [160, 218], [160, 112], [365, 112], [365, 322], [590, 322], [590, 198], [808, 198]];
    const pathSeg = [], pathCum = [0];
    let pathLen = 0;
    for (let i = 1; i < pts.length; i++) {
        let a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        pathSeg.push(d);
        pathLen += d;
        pathCum.push(pathLen);
    }
    // MINI-GAME SETTINGS -------------------------------------------------------
    // Change build pads, costs, range, damage, and speed here.
    const spots = [[94, 106], [262, 55], [266, 245], [444, 203], [467, 392], [695, 120], [709, 290]];
    const info = { spark: { cost: 35, range: 145, damage: 1.2, speed: .48, color: '#fff1a4' }, compass: { cost: 50, range: 220, damage: 2.0, speed: 1.22, color: '#d1e5f8' }, lantern: { cost: 40, range: 140, damage: 0.8, speed: .82, color: '#f5b2a5' } };
    let game, anim = 0, previous = 0;
    // Short local Web Audio cues; the context is created only after a player acts.
    let soundEnabled = true, audioContext = null, lastShotSoundAt = 0;
    function playSfx(name) {
        if (!soundEnabled)
            return;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass)
            return;
        try {
            audioContext ||= new AudioContextClass();
            if (audioContext.state === 'suspended')
                audioContext.resume().catch(() => {});
            const now = audioContext.currentTime;
            const tone = (frequency, duration, delay = 0, volume = .025, type = 'sine', endFrequency = frequency) => {
                const oscillator = audioContext.createOscillator();
                const gain = audioContext.createGain();
                const start = now + delay;
                oscillator.type = type;
                oscillator.frequency.setValueAtTime(frequency, start);
                oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), start + duration);
                gain.gain.setValueAtTime(.0001, start);
                gain.gain.exponentialRampToValueAtTime(volume, start + .012);
                gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
                oscillator.connect(gain);
                gain.connect(audioContext.destination);
                oscillator.start(start);
                oscillator.stop(start + duration + .015);
            };
            if (name === 'select') tone(530, .06, 0, .018, 'triangle', 670);
            if (name === 'place') { tone(320, .08, 0, .03, 'triangle', 250); tone(560, .11, .07, .025, 'sine', 760); }
            if (name === 'wave') { tone(220, .12, 0, .035, 'triangle', 260); tone(330, .13, .09, .032, 'triangle', 390); tone(495, .17, .2, .03, 'sine', 620); }
            if (name === 'shot') {
                const stamp = performance.now();
                if (stamp - lastShotSoundAt < 190) return;
                lastShotSoundAt = stamp;
                tone(760, .035, 0, .009, 'square', 470);
            }
            if (name === 'coin') { tone(740, .075, 0, .018, 'sine', 980); tone(1080, .085, .06, .015, 'sine', 1320); }
            if (name === 'damage') { tone(150, .19, 0, .045, 'triangle', 72); }
            if (name === 'win') { tone(440, .14, 0, .03); tone(554, .16, .11, .03); tone(740, .23, .23, .035); }
            if (name === 'loss') { tone(280, .16, 0, .035, 'triangle', 200); tone(180, .25, .13, .04, 'triangle', 95); }
        }
        catch (error) {
            // Sound is optional; audio device or browser restrictions never block play.
        }
    }
    function syncSoundToggle() {
        const button = $('soundToggle');
        if (!button) return;
        button.textContent = soundEnabled ? 'Sound: on' : 'Sound: off';
        button.setAttribute('aria-pressed', String(soundEnabled));
    }
    function snapshotGame() { if (!game)
        return; state.game = { ...game, active: false, enemies: [], bullets: [], wave: game.active ? Math.max(0, game.wave - 1) : game.wave, style: game.ended ? playStyle().name : undefined }; save(); }
    function newGame(restoreSaved = false) {
        game = restoreSaved && state.game ? { ...state.game, active: false, enemies: [], bullets: [] } : { money: 140, lives: 5, wave: 0, saved: 0, shots: 0, towers: [], enemies: [], bullets: [], selected: null, active: false, ended: false, nextSpawn: 0, spawned: 0, prebuild: 0, postbuild: 0, firstPlaceAt: 0, types: [], startedEmpty: false };
        hasChosenTower = Boolean(game.selected || game.towers.length);
        $('gameEnd').classList.remove('active');
        if (game.ended) {
            let t = playStyle();
            $('gameType').textContent = t.name;
            $('gameInterpret').textContent = t.detail;
            $('gameEnd').classList.add('active');
        }
        setGameMsg(restoreSaved && state.game ? 'Your defenses have been restored.' : 'Select a defense, then tap a numbered build pad.');
        updateGameText();
        paintGame();
        snapshotGame();
    }
    function setGameMsg(s) { $('gameState').textContent = s; }
    function updateGameText() {
        $('coins').textContent = game.money;
        $('lives').textContent = game.lives;
        $('wave').textContent = game.wave + ' / 2';
        $('saved').textContent = game.saved;
        updateGuide();
    }
    function locAlong(t) { let d = Math.max(0, Math.min(pathLen, t)); for (let i = 0; i < pathSeg.length; i++) {
        if (d <= pathCum[i + 1]) {
            let f = (d - pathCum[i]) / pathSeg[i];
            return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
        }
    } return pts[pts.length - 1]; }
    function circle(x, y, r, fill, stroke = '#31493c', lw = 2) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lw;
        ctx.stroke();
    } }
    function rounded(x, y, w, h, r, fill) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fillStyle = fill; ctx.fill(); }
    // WORLD MAP: felt board, stitched parchment lane, and a physical castle miniature.
    function scenery() {
        ctx.fillStyle = '#71936c';
        ctx.fillRect(0, 0, W, H);

        // Fine flecks suggest the green felt used for the homepage board miniature.
        const feltSpecks = ['#84a27b', '#5f835d', '#789a70', '#91a980'];
        for (let i = 0; i < 190; i++) {
            const x = (19 + i * 137) % W;
            const y = (11 + i * 71 + i * i * 13) % H;
            ctx.fillStyle = feltSpecks[i % feltSpecks.length];
            ctx.fillRect(x, y, i % 5 === 0 ? 3 : 2, 1.5);
        }
        for (const [x, y, r] of [[31, 58, 22], [335, 438, 32], [780, 28, 26], [851, 382, 37], [549, 57, 23]]) {
            circle(x, y + 5, r, '#5f855b', '', 0);
            circle(x - 7, y, r * .68, '#87a878', '', 0);
            circle(x + 8, y - 5, r * .48, '#789b6d', '', 0);
        }

        // Path: thick outline, cream fill, dashed guide line.
        ctx.beginPath();
        ctx.moveTo(...pts[0]);
        pts.slice(1).forEach(p => ctx.lineTo(...p));
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);
        ctx.strokeStyle = '#52624a';
        ctx.lineWidth = 68;
        ctx.stroke();
        ctx.strokeStyle = '#e8d2a6';
        ctx.lineWidth = 56;
        ctx.stroke();
        ctx.setLineDash([4, 10]);
        ctx.strokeStyle = '#fff1cf';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);

        // Small route labels make the objective legible before the first wave.
        rounded(24, 20, 132, 28, 2, '#fffefa');
        ctx.strokeStyle = '#252632';
        ctx.lineWidth = 2;
        ctx.strokeRect(24, 20, 132, 28);
        ctx.fillStyle = '#252632';
        ctx.font = '900 12px system-ui,sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('ENEMY ENTRY  →', 34, 39);
        rounded(625, 20, 102, 25, 2, '#ffd15c');
        ctx.strokeStyle = '#252632';
        ctx.lineWidth = 2;
        ctx.strokeRect(625, 20, 102, 25);
        ctx.fillStyle = '#252632';
        ctx.font = '900 11px system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('CASTLE GATE', 676, 32.5);

        // The towers have pointed roofs. The gate sits at the end of the road.
        const castle = gameArt.castle;
        if (castle?.complete && castle.naturalWidth) {
            ctx.drawImage(castle, 734, 26, 148, 204);
        } else {
            // Lightweight vector fallback while the inline SVG is decoding.
            ctx.fillStyle = '#f6e3b9';
            ctx.strokeStyle = '#252632';
            ctx.lineWidth = 5;
            ctx.fillRect(790, 109, 78, 102);
            ctx.strokeRect(790, 109, 78, 102);
            for (const [cx, color] of [[791, '#b8acf4'], [866, '#48b8aa']]) {
                ctx.fillStyle = color;
                ctx.beginPath(); ctx.moveTo(cx - 12, 113); ctx.lineTo(cx + 13, 63); ctx.lineTo(cx + 38, 113); ctx.closePath(); ctx.fill(); ctx.stroke();
            }
            ctx.fillStyle = '#252632';
            rounded(820, 163, 28, 48, 13, '#252632');
        }
    }
    function paintTower(t) {
        const img = gameArt[t.kind];
        if (img?.complete && img.naturalWidth) {
            ctx.drawImage(img, t.x - 34, t.y - 50, 68, 76);
        }
        else {
            circle(t.x, t.y, 18, info[t.kind].color, '#5f705f', 2);
        }
    }
    function paintEnemy(e, x, y) {
        const img = gameArt[e.kind || 'scout'];
        if (img?.complete && img.naturalWidth)
            ctx.drawImage(img, x - 23, y - 32, 46, 52);
        else
            circle(x, y, 13, '#aa7f71', '#775548', 2);
        ctx.fillStyle = '#345946';
        ctx.fillRect(x - 16, y - 31, 32, 5);
        ctx.fillStyle = '#b5e49d';
        ctx.fillRect(x - 16, y - 31, 32 * Math.max(0, e.hp / e.maxHP), 5);
    }
    function paintBullet(b) {
        const target = locAlong(b.to.d);
        const angle = Math.atan2(target[1] - b.y, target[0] - b.x);
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(angle);
        if (b.kind === 'spark') {
            ctx.shadowColor = '#ffd15c';
            ctx.shadowBlur = 12;
            ctx.fillStyle = '#ffe37b';
            ctx.strokeStyle = '#4a3a61';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(9, 0); ctx.lineTo(2, 4); ctx.lineTo(-5, 0); ctx.lineTo(2, -4); ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#fffdf1';
            ctx.fillRect(-8, -1, 3, 2);
        } else if (b.kind === 'compass') {
            ctx.shadowColor = '#9fe4f1';
            ctx.shadowBlur = 5;
            ctx.fillStyle = '#d8f7ff';
            ctx.strokeStyle = '#29465a';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(10, 0); ctx.lineTo(-5, 4); ctx.lineTo(-2, 0); ctx.lineTo(-5, -4); ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.strokeStyle = '#fff';
            ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(-4, 0); ctx.stroke();
        } else {
            ctx.shadowColor = '#ff947e';
            ctx.shadowBlur = 13;
            ctx.strokeStyle = '#8c4161';
            ctx.lineWidth = 1.5;
            ctx.fillStyle = '#ffb8a7';
            ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#fff4cf';
            ctx.beginPath(); ctx.arc(1, -1, 1.8, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#ffd6aa';
            ctx.beginPath(); ctx.moveTo(-7, 0); ctx.lineTo(-5, 0); ctx.stroke();
        }
        ctx.restore();
    }
    function drawEmptySlot(x, y, i) {
        ctx.save();
        ctx.shadowColor = '#2d382c88';
        ctx.shadowBlur = hoveredSlot === i ? 14 : 3;
        circle(x, y + 4, 27, '#69543e', '', 0);
        circle(x, y, 25, hoveredSlot === i ? '#f2d58f' : '#c6a878', '#463a30', 2.5);
        ctx.setLineDash([3, 4]);
        circle(x, y, 20, '#d9c397', '#f6e7c7', 1.5);
        ctx.setLineDash([]);
        ctx.restore();
        if (game?.selected && !game.ended && game.money >= info[game.selected].cost && hoveredSlot === i) {
            const img = gameArt[game.selected];
            if (img?.complete && img.naturalWidth) {
                ctx.save();
                ctx.globalAlpha = .63;
                ctx.drawImage(img, x - 34, y - 49, 68, 76);
                ctx.restore();
            }
        }
        else {
            ctx.fillStyle = '#252632';
            ctx.font = '800 18px system-ui,sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(String(i + 1), x, y + 6);
        }
    }
    function paintGame() {
        if (!game)
            return;
        ctx.clearRect(0, 0, W, H);
        scenery();
        spots.forEach((p, i) => { const t = game.towers.find(t => t.slot === i); if (t)
            paintTower(t);
        else
            drawEmptySlot(p[0], p[1], i); });
        game.enemies.forEach(e => { let [x, y] = locAlong(e.d); paintEnemy(e, x, y); });
        game.bullets.forEach(paintBullet);
        if (game.ended) {
            rounded(336, 12, 228, 34, 2, '#ffd15c');
            ctx.fillStyle = '#252632';
            ctx.font = 'bold 15px system-ui,sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Round complete', 450, 35);
        }
    }
    function placeTower(slot) {
        if (game.ended) {
            notify('This round is complete. Restart to play again.');
            return;
        }
        if (!game.selected) {
            notify('Choose a defense first, then choose a numbered build pad.');
            setGameMsg('Step 1: select a defense on the right.');
            return;
        }
        if (game.towers.some(t => t.slot === slot)) {
            notify('Pad ' + (slot + 1) + ' is occupied. Try another pad.', 'warn');
            return;
        }
        const ty = game.selected, cost = info[ty].cost;
        if (game.money < cost) {
            showCoinShortage(cost);
            return;
        }
        const p = spots[slot];
        game.money -= cost;
        game.towers.push({ slot, x: p[0], y: p[1], kind: ty, cooldown: 0 });
        playSfx('place');
        if (game.active)
            game.postbuild++;
        else
            game.prebuild++;
        if (!game.firstPlaceAt)
            game.firstPlaceAt = Date.now();
        if (!game.types.includes(ty))
            game.types.push(ty);
        event('Built tower', ty + ' at pad ' + (slot + 1));
        const name = ty === 'spark' ? 'Spark crystal' : ty === 'compass' ? 'Archer lookout' : 'Glow lantern';
        setGameMsg(name + ' placed on pad ' + (slot + 1) + '. ' + (game.active ? 'Keep defending!' : 'You can place another or start wave 1.'));
        notify(name + ' placed on pad ' + (slot + 1) + '.');
        if (game.money < info[ty].cost)
            game.selected = null;
        hoveredSlot = -1;
        updateGameText();
        paintGame();
        snapshotGame();
    }
    const pointerPoint = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
    canvas.addEventListener('pointermove', e => { const [x, y] = pointerPoint(e); const next = spots.findIndex(p => Math.hypot(p[0] - x, p[1] - y) <= 36 && !(game?.towers || []).some(t => t.x === p[0] && t.y === p[1])); if (next !== hoveredSlot) {
        hoveredSlot = next;
        canvas.style.cursor = next >= 0 ? 'pointer' : 'default';
        paintGame();
    } });
    canvas.addEventListener('pointerleave', () => { hoveredSlot = -1; paintGame(); });
    canvas.addEventListener('click', e => { const [x, y] = pointerPoint(e); const idx = spots.findIndex(p => Math.hypot(p[0] - x, p[1] - y) <= 39); if (idx >= 0)
        placeTower(idx);
    else
        notify('Tap one of the numbered build pads.', 'warn'); });
    for (let i = 0; i < spots.length; i++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = i + 1;
        b.setAttribute('aria-label', 'Build on pad ' + (i + 1));
        b.addEventListener('click', () => placeTower(i));
        $('padControls').appendChild(b);
    }
    document.querySelectorAll('[data-tower]').forEach(b => b.addEventListener('click', () => {
        const type = b.dataset.tower;
        if (game.ended) {
            notify('Restart the round to build more defenses.');
            return;
        }
        if (game.money < info[type].cost) {
            showCoinShortage(info[type].cost);
            return;
        }
        game.selected = type;
        playSfx('select');
        hasChosenTower = true;
        event('Selected tower', type);
        setGameMsg('Step 2: tap any glowing numbered pad on the map.');
        notify('Selected ' + (type === 'spark' ? 'Spark crystal' : type === 'compass' ? 'Archer lookout' : 'Glow lantern') + ' → tap a build pad.');
        updateGameText();
        paintGame();
        snapshotGame();
    }));
    function startWave() { if (game.active || game.ended || game.wave >= 2)
        return; if (!gameArtReady) {
        notify('The artwork is still preparing.', 'warn');
        return;
    } playSfx('wave'); if (game.towers.length === 0)
        notify('No defenses placed yet. You can still play, but the castle is unprotected.', 'warn'); game.wave++; game.active = true; game.nextSpawn = 0; game.spawned = 0; if (game.towers.length === 0)
        game.startedEmpty = true; event('Started wave', String(game.wave) + '; towers ' + game.towers.length); setGameMsg('Wave ' + game.wave + ' is coming. Place more towers whenever you like.'); updateGameText(); previous = performance.now(); cancelAnimationFrame(anim); snapshotGame(); anim = requestAnimationFrame(tick); }
    function tick(now) { if (!game.active)
        return; let dt = Math.min(.045, (now - previous) / 1000); previous = now; game.nextSpawn -= dt; const max = game.wave === 1 ? 7 : 10; if (game.spawned < max && game.nextSpawn <= 0) {
        const kind = game.wave === 2 && game.spawned % 3 === 0 ? 'brute' : 'scout';
        const hp = game.wave === 1 ? 3.2 : kind === 'brute' ? 5.8 : 4.6;
        game.enemies.push({ d: 0, hp, maxHP: hp, slow: 0, kind });
        game.spawned++;
        game.nextSpawn = .9;
    } game.enemies.forEach(e => { e.d += (e.slow > 0 ? 76 : 112) * dt; if (e.slow > 0)
        e.slow = Math.max(0, e.slow - dt); }); const livesBefore = game.lives; game.enemies = game.enemies.filter(e => { if (e.d >= pathLen) {
        game.lives--;
        return false;
    } return true; }); for (let t of game.towers) {
        t.cooldown -= dt;
        if (t.cooldown <= 0) {
            let targets = game.enemies.filter(e => { const p = locAlong(e.d); return Math.hypot(p[0] - t.x, p[1] - t.y) <= info[t.kind].range; });
            if (targets.length) {
                playSfx('shot');
                let target = targets.reduce((a, b) => a.d > b.d ? a : b);
                let p = locAlong(target.d);
                game.bullets.push({ x: t.x, y: t.y, to: target, kind: t.kind, color: info[t.kind].color, life: .22 });
                target.hp -= info[t.kind].damage;
                if (t.kind === 'lantern')
                    target.slow = 1.5;
                t.cooldown = info[t.kind].speed;
                game.shots++;
            }
        }
    } for (let b of game.bullets) {
        b.life -= dt;
        let p = locAlong(b.to.d);
        b.x += (p[0] - b.x) * .27;
        b.y += (p[1] - b.y) * .27;
    } game.bullets = game.bullets.filter(b => b.life > 0); let killed = game.enemies.filter(e => e.hp <= 0).length; if (killed) {
        game.money += killed * 13;
        game.saved += killed;
    } game.enemies = game.enemies.filter(e => e.hp > 0); if (killed) playSfx('coin'); if (game.lives < livesBefore) playSfx('damage'); if (game.lives <= 0) {
        game.lives = 0;
        finishGame('castle overrun');
        return;
    } if (game.spawned >= max && game.enemies.length === 0) {
        game.active = false;
        game.money += 25;
        event('Finished wave', 'Wave ' + game.wave + ' · castle lives ' + game.lives);
        setGameMsg(game.wave >= 2 ? 'Both waves complete!' : 'Wave cleared. +25 coins. Choose a defense or start wave 2.');
        notify(game.wave >= 2 ? 'Both waves complete!' : 'Wave cleared · +25 coins');
        if (game.wave === 2) {
            finishGame('two waves completed');
            return;
        }
        snapshotGame();
    } updateGameText(); paintGame(); if (game.active)
        anim = requestAnimationFrame(tick); }
    function playStyle() { if (game.towers.length === 0)
        return { name: 'Explored the map', detail: 'You looked around without placing defenses.' }; if (game.startedEmpty && game.postbuild > 0)
        return { name: 'Built during the wave', detail: 'You started the wave first, then added defenses as it unfolded.' }; if (game.types.length >= 3)
        return { name: 'Tried different towers', detail: 'You used several tower types during this round.' }; if (game.prebuild >= 2)
        return { name: 'Prepared ahead', detail: 'You placed multiple defenses before starting the wave.' }; return { name: 'Focused defense', detail: 'You used a small set of defenses throughout the round.' }; }
    function finishGame(reason = 'finished early') { if (game.ended)
        return; if (reason === 'two waves completed') playSfx('win'); else if (reason === 'castle overrun') playSfx('loss'); game.active = false; game.ended = true; cancelAnimationFrame(anim); let s = playStyle(); $('gameType').textContent = s.name; $('gameInterpret').textContent = s.detail; $('gameEnd').classList.add('active'); game && (state.game = { ...game, style: s.name, endedBecause: reason, enemies: [], bullets: [] }); event('Finished game', reason + '; style ' + s.name); setGameMsg('Your round is complete. The observation is available below.'); updateGameText(); paintGame(); snapshotGame(); }
    $('startWave').addEventListener('click', startWave);
    $('soundToggle').addEventListener('click', () => { soundEnabled = !soundEnabled; syncSoundToggle(); });
    syncSoundToggle();
    // Mobile repeats this action beneath the map. Both buttons start the same wave.
    $('startWaveMobile').addEventListener('click', startWave);
    $('resetGame').addEventListener('click', () => { cancelAnimationFrame(anim); event('Restarted mini-game', ''); newGame(); });
    $('endGame').addEventListener('click', () => finishGame('ended by visitor'));
    // REFLECTION & DATA EXPORT -------------------------------------------------
    function renderReport() {
        duration();
        $('rDuration').textContent = elapsed(totalTime());
        $('rEvents').textContent = state.events.length;
        $('rVisited').textContent = state.visited.length + '/3';
        $('storagePill').textContent = storageOK ? 'Saved locally' : 'Storage unavailable';
        $('statusLocal').textContent = recordingOn ? (storageOK ? 'Local notes on' : 'Memory only') : 'Notes paused';
        $('toggleTracking').textContent = recordingOn ? 'Pause recording' : 'Resume recording';
        const data = [['Story', state.ms.about], ['Face lab', state.ms.camera], ['Game', state.ms.game], ['Reflection', state.ms.report]];
        const high = Math.max(1, ...data.map(x => x[1]));
        $('timeBars').innerHTML = data.map(([k, v]) => '<div class="barline"><span>' + k + '</span><div class="track"><div class="fill" style="width:' + ((v / high) * 100).toFixed(1) + '%"></div></div><span>' + elapsed(v) + '</span></div>').join('');
        $('reportInterpret').innerHTML = '<ul class="report-inputs"><li>Time means screen time, not attention.</li><li>Your answer and game actions are included only if provided.</li></ul>';
        let list = state.events.slice(-45);
        $('eventLog').innerHTML = list.length ? list.map(e => '<li><span class="time">' + new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '</span><span class="labelval"><strong>' + safe(e.name) + '</strong>' + (e.detail ? '<br>' + safe(e.detail) : '') + '</span></li>').join('') : '<li>No events recorded. This report stays useful even when nothing else was explored.</li>';
        lastStart = performance.now();
        save();
    }
    $('downloadLog').addEventListener('click', () => { duration(); snapshotGame(); let payload = JSON.stringify({ type: 'Houtan interaction notes', savedAt: new Date().toISOString(), data: state }, null, 2); const blob = new Blob([payload], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'houtan_interaction_notes.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500); event('Exported notes', 'JSON'); });
    $('importLog').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', async (e) => { const f = e.target.files?.[0]; if (!f)
        return; try {
        let j = JSON.parse(await f.text());
        const d = j.data;
        if (!d || ![4, 5, 6, 7].includes(d.version) || !Array.isArray(d.events) || !d.ms || !Array.isArray(d.visited))
            throw Error('Invalid backup');
        stopCam();
        state = { ...state, ...d, screen: 'report', tracking: true };
        recordingOn = true;
        lastStart = performance.now();
        cancelAnimationFrame(anim);
        newGame(true);
        event('Restored notes', 'Imported backup');
        show('report', { silent: true });
        save();
    }
    catch (err) {
        alert('This file is not a valid Houtan session backup.');
    } e.target.value = ''; });
    $('clearLog').addEventListener('click', () => { if (!confirm('Erase all local session notes from this browser?'))
        return; stopCam(); try {
        localStorage.removeItem(KEY);
    }
    catch (e) { } state = { version: 6, created: Date.now(), screen: 'home', tracking: recordingOn, events: [], ms: { home: 0, about: 0, camera: 0, game: 0, report: 0 }, visited: [], selfReport: '', cameraEver: false, game: null }; lastStart = performance.now(); cancelAnimationFrame(anim); newGame(); show('home', { silent: true }); });
    $('toggleTracking').addEventListener('click', () => { duration(); recordingOn = !recordingOn; state.tracking = recordingOn; if (!recordingOn) {
        try {
            localStorage.removeItem(KEY);
        }
        catch (e) { }
    }
    else
        event('Resumed recording', ''); lastStart = performance.now(); renderReport(); });
    // SESSION LIFECYCLE --------------------------------------------------------
    window.addEventListener('visibilitychange', () => { duration(); if (document.visibilityState === 'hidden')
        save(); });
    window.addEventListener('pagehide', () => { duration(); save(); stopCam(); });
    setInterval(() => { if (document.visibilityState === 'visible') {
        duration();
        snapshotGame();
        save();
    } }, 3000);
    newGame(restored);
    renderDiagnostics();
    loadGameArt().catch(() => { $('gameReadyText').textContent = 'Using simple built-in artwork'; $('gameAssetLoader').classList.remove('active'); gameArtReady = true; paintGame(); });
    if (restored) {
        const wanted = ids.includes(state.screen) ? state.screen : 'home';
        state.screen = 'home';
        show(wanted, { silent: true });
        event('Returned after reload', 'Restored local notes');
    }
    else {
        event('Opened experience', 'Three doors');
    }
    document.querySelectorAll('.topnav button').forEach(b => b.classList.toggle('active', b.dataset.go === state.screen));
    $('statusLocal').textContent = recordingOn ? 'Local notes on' : 'Notes paused';
    // ---------------------------------------------------------------------------
    // Accessibility: announce the current section and redraw hidden diagnostics
    // after they become visible. This does not collect additional information.
    // ---------------------------------------------------------------------------
    const advancedDetails = document.getElementById('advancedDiagnostics');
    if (advancedDetails) {
        advancedDetails.addEventListener('toggle', () => {
            if (advancedDetails.open) {
                renderDiagnostics();
                drawAngerChart();
            }
        });
    }
})();
// Story category carousels
(() => {
  document.querySelectorAll('[data-category-slider]').forEach(track => {
    const cards = [...track.children];
    const category = track.closest('.experience-category');
    const count = category.querySelector('[data-category-count]');
    const controls = category.querySelector('.category-controls');
    let active = 0;
    const show = next => {
      active = (next + cards.length) % cards.length;
      cards.forEach((card, index) => card.classList.toggle('is-active', index === active));
      count.textContent = `${active + 1} / ${cards.length}`;
    };
    show(0);
    if (cards.length < 2 && controls) controls.hidden = true;
    category.addEventListener('click', event => {
      if (event.target.closest('[data-category-prev]')) show(active - 1);
      if (event.target.closest('[data-category-next]')) show(active + 1);
    });
  });
})();
