// ===== State =====
let state = {
    azimuth: 0,
    elevation: 0,
    distance: 5
};

// ===== DOM Elements =====
const elements = {};

// ===== Camera Angle Labels =====
function getAzimuthLabel(deg) {
    deg = ((deg % 360) + 360) % 360;
    if (deg <= 22.5 || deg > 337.5) return '前方';
    if (deg <= 67.5) return '右前方';
    if (deg <= 112.5) return '右方';
    if (deg <= 157.5) return '右后方';
    if (deg <= 202.5) return '后方';
    if (deg <= 247.5) return '左后方';
    if (deg <= 292.5) return '左方';
    return '左前方';
}

function getElevationLabelFromAngle(deg) {
    if (deg <= -15) return '低角度（仰视）';
    if (deg <= 15) return '平视';
    if (deg <= 45) return '升高';
    if (deg <= 75) return '高角度';
    return "俯视（向下看）";
}

function getZoomLabel(val) {
    if (val <= 2) return '广角镜头（远景）';
    if (val <= 4) return '中等广角';
    if (val <= 6) return '中景';
    if (val <= 8) return '中景特写';
    return '特写（非常近）';
}

// ===== Utility Functions =====
function updatePromptDisplay() {
    const azLabel = getAzimuthLabel(state.azimuth);
    const elLabel = getElevationLabelFromAngle(state.elevation);
    const zoomLabel = getZoomLabel(state.distance);

    elements.promptDisplay.innerHTML = `
        <div class="param-display">
            <span class="param-name">水平角度：</span> <span class="param-value">${state.azimuth}°</span> <span class="param-label">(${azLabel})</span>
        </div>
        <div class="param-display">
            <span class="param-name">垂直角度：</span> <span class="param-value">${state.elevation}°</span> <span class="param-label">(${elLabel})</span>
        </div>
        <div class="param-display">
            <span class="param-name">缩放：</span> <span class="param-value">${state.distance}</span> <span class="param-label">(${zoomLabel})</span>
        </div>
    `;
}

function updateSliderValues() {
    elements.azimuthValue.textContent = `${Math.round(state.azimuth)}°`;
    elements.elevationValue.textContent = `${Math.round(state.elevation)}°`;
    elements.distanceValue.textContent = state.distance.toFixed(1);
}

// ===== Three.js Scene =====
let threeScene = null;

function initThreeJS() {
    const container = elements.threejsContainer;

    // 增加宽高兜底，防止极端情况下取到 0 导致移动端内核崩溃
    const width = container.clientWidth || window.innerWidth - 40;
    const height = container.clientHeight || 280;

    // 针对夸克/vivo等浏览器如果 Three.js 没加载成功给出友好提示
    if (typeof THREE === 'undefined') {
        container.innerHTML = `<div style="text-align:center; padding:50px; color:#f56c6c;">3D引擎加载被浏览器拦截<br>请关闭网页的"去广告"或更换浏览器</div>`;
        return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0f);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(4, 3.5, 4);
    camera.lookAt(0, 0.3, 0);

    let renderer;
    try {
        // 【关键防御】针对国产浏览器降低渲染要求，关闭 antialias
        renderer = new THREE.WebGLRenderer({ 
            antialias: false, // 手机端强制关闭，能解决 80% 的闪退和黑屏
            alpha: true,
            powerPreference: "high-performance" // 抢占资源防止被系统休眠
        });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // 限制最高像素比，防止内存溢出
        container.innerHTML = ''; // 清空可能存在的错误提示
        container.appendChild(renderer.domElement);
    } catch (e) {
        console.error("WebGL 创建失败，手机不支持或已被浏览器拦截:", e);
        container.innerHTML = `<div style="text-align:center; padding:50px; color:#f56c6c;">当前浏览器内核不支持3D渲染<br>推荐使用 Chrome 或 Edge 浏览器</div>`;
        return; // 中断渲染流程，但不影响其他参数功能
    }

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);
    const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
    mainLight.position.set(5, 10, 5);
    scene.add(mainLight);
    const fillLight = new THREE.DirectionalLight(0xE93D82, 0.3);
    fillLight.position.set(-5, 5, -5);
    scene.add(fillLight);

    const gridHelper = new THREE.GridHelper(5, 20, 0x1a1a2e, 0x12121a);
    gridHelper.position.y = -0.01;
    scene.add(gridHelper);

    const CENTER = new THREE.Vector3(0, 0.5, 0);
    const AZIMUTH_RADIUS = 1.8;
    const ELEVATION_RADIUS = 1.4;

    let liveAzimuth = state.azimuth;
    let liveElevation = state.elevation;
    let liveDistance = state.distance;

    // Subject plane
    const planeGeo = new THREE.PlaneGeometry(1.2, 1.2);
    const planeMat = new THREE.MeshBasicMaterial({ color: 0x3a3a4a, side: THREE.DoubleSide });
    const imagePlane = new THREE.Mesh(planeGeo, planeMat);
    imagePlane.position.copy(CENTER);
    scene.add(imagePlane);

    const frameGeo = new THREE.EdgesGeometry(planeGeo);
    const frameMat = new THREE.LineBasicMaterial({ color: 0xE93D82 });
    const imageFrame = new THREE.LineSegments(frameGeo, frameMat);
    imageFrame.position.copy(CENTER);
    scene.add(imageFrame);

    const glowRingGeo = new THREE.RingGeometry(0.55, 0.58, 64);
    const glowRingMat = new THREE.MeshBasicMaterial({ color: 0xE93D82, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
    const glowRing = new THREE.Mesh(glowRingGeo, glowRingMat);
    glowRing.position.set(0, 0.01, 0);
    glowRing.rotation.x = -Math.PI / 2;
    scene.add(glowRing);

    // Camera indicator
    const camGeo = new THREE.ConeGeometry(0.15, 0.4, 4);
    const camMat = new THREE.MeshStandardMaterial({ color: 0xE93D82, emissive: 0xE93D82, emissiveIntensity: 0.5, metalness: 0.8, roughness: 0.2 });
    const cameraIndicator = new THREE.Mesh(camGeo, camMat);
    scene.add(cameraIndicator);

    const camGlowGeo = new THREE.SphereGeometry(0.08, 16, 16);
    const camGlowMat = new THREE.MeshBasicMaterial({ color: 0xff6ba8, transparent: true, opacity: 0.8 });
    const camGlow = new THREE.Mesh(camGlowGeo, camGlowMat);
    scene.add(camGlow);

    // Azimuth ring
    const azRingGeo = new THREE.TorusGeometry(AZIMUTH_RADIUS, 0.04, 16, 100);
    const azRingMat = new THREE.MeshBasicMaterial({ color: 0xE93D82, transparent: true, opacity: 0.7 });
    const azimuthRing = new THREE.Mesh(azRingGeo, azRingMat);
    azimuthRing.rotation.x = Math.PI / 2;
    azimuthRing.position.y = 0.02;
    scene.add(azimuthRing);

    const azHandleGeo = new THREE.SphereGeometry(0.16, 32, 32);
    const azHandleMat = new THREE.MeshStandardMaterial({ color: 0xE93D82, emissive: 0xE93D82, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.4 });
    const azimuthHandle = new THREE.Mesh(azHandleGeo, azHandleMat);
    scene.add(azimuthHandle);

    const azGlowGeo = new THREE.SphereGeometry(0.22, 16, 16);
    const azGlowMat = new THREE.MeshBasicMaterial({ color: 0xE93D82, transparent: true, opacity: 0.2 });
    const azGlow = new THREE.Mesh(azGlowGeo, azGlowMat);
    scene.add(azGlow);

    // Elevation arc
    const ELEV_ARC_X = -0.8;
    const arcPoints = [];
    for (let i = 0; i <= 32; i++) {
        const angle = (-30 + (120 * i / 32)) * Math.PI / 180;
        arcPoints.push(new THREE.Vector3(
            ELEV_ARC_X,
            ELEVATION_RADIUS * Math.sin(angle) + CENTER.y,
            ELEVATION_RADIUS * Math.cos(angle)
        ));
    }
    const arcCurve = new THREE.CatmullRomCurve3(arcPoints);
    const elArcGeo = new THREE.TubeGeometry(arcCurve, 32, 0.04, 8, false);
    const elArcMat = new THREE.MeshBasicMaterial({ color: 0x00FFD0, transparent: true, opacity: 0.8 });
    const elevationArc = new THREE.Mesh(elArcGeo, elArcMat);
    scene.add(elevationArc);

    const elHandleGeo = new THREE.SphereGeometry(0.16, 32, 32);
    const elHandleMat = new THREE.MeshStandardMaterial({ color: 0x00FFD0, emissive: 0x00FFD0, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.4 });
    const elevationHandle = new THREE.Mesh(elHandleGeo, elHandleMat);
    scene.add(elevationHandle);

    const elGlowGeo = new THREE.SphereGeometry(0.22, 16, 16);
    const elGlowMat = new THREE.MeshBasicMaterial({ color: 0x00FFD0, transparent: true, opacity: 0.2 });
    const elGlow = new THREE.Mesh(elGlowGeo, elGlowMat);
    scene.add(elGlow);

    // Distance handle
    const distHandleGeo = new THREE.SphereGeometry(0.15, 32, 32);
    const distHandleMat = new THREE.MeshStandardMaterial({ color: 0xFFB800, emissive: 0xFFB800, emissiveIntensity: 0.7, metalness: 0.5, roughness: 0.3 });
    const distanceHandle = new THREE.Mesh(distHandleGeo, distHandleMat);
    scene.add(distanceHandle);

    const distGlowGeo = new THREE.SphereGeometry(0.22, 16, 16);
    const distGlowMat = new THREE.MeshBasicMaterial({ color: 0xFFB800, transparent: true, opacity: 0.25 });
    const distGlow = new THREE.Mesh(distGlowGeo, distGlowMat);
    scene.add(distGlow);

    let distanceTube = null;
    function updateDistanceLine(start, end) {
        if (distanceTube) scene.remove(distanceTube);
        const path = new THREE.LineCurve3(start, end);
        const tubeGeo = new THREE.TubeGeometry(path, 1, 0.025, 8, false);
        const tubeMat = new THREE.MeshBasicMaterial({ color: 0xFFB800, transparent: true, opacity: 0.8 });
        distanceTube = new THREE.Mesh(tubeGeo, tubeMat);
        scene.add(distanceTube);
    }

    // Guide lines
    const verticalGuideGeo = new THREE.BufferGeometry();
    const verticalGuideMat = new THREE.LineDashedMaterial({ color: 0xE93D82, dashSize: 0.1, gapSize: 0.05, transparent: true, opacity: 0.6 });
    const verticalGuide = new THREE.Line(verticalGuideGeo, verticalGuideMat);
    scene.add(verticalGuide);

    const horizontalGuideGeo = new THREE.BufferGeometry();
    const horizontalGuideMat = new THREE.LineDashedMaterial({ color: 0xE93D82, dashSize: 0.1, gapSize: 0.05, transparent: true, opacity: 0.6 });
    const horizontalGuide = new THREE.Line(horizontalGuideGeo, horizontalGuideMat);
    scene.add(horizontalGuide);

    const elevationGuideGeo = new THREE.BufferGeometry();
    const elevationGuideMat = new THREE.LineDashedMaterial({ color: 0x00FFD0, dashSize: 0.1, gapSize: 0.05, transparent: true, opacity: 0.6 });
    const elevationGuide = new THREE.Line(elevationGuideGeo, elevationGuideMat);
    scene.add(elevationGuide);

    const groundMarkerGeo = new THREE.SphereGeometry(0.06, 16, 16);
    const groundMarkerMat = new THREE.MeshBasicMaterial({ color: 0xE93D82, transparent: true, opacity: 0.7 });
    const groundMarker = new THREE.Mesh(groundMarkerGeo, groundMarkerMat);
    scene.add(groundMarker);

    function updateVisuals() {
        const azRad = (liveAzimuth * Math.PI) / 180;
        const elRad = (liveElevation * Math.PI) / 180;
        const visualDist = 2.6 - (liveDistance / 10) * 2.0;

        const camX = visualDist * Math.sin(azRad) * Math.cos(elRad);
        const camY = CENTER.y + visualDist * Math.sin(elRad);
        const camZ = visualDist * Math.cos(azRad) * Math.cos(elRad);

        cameraIndicator.position.set(camX, camY, camZ);
        cameraIndicator.lookAt(CENTER);
        cameraIndicator.rotateX(Math.PI / 2);
        camGlow.position.copy(cameraIndicator.position);

        const azX = AZIMUTH_RADIUS * Math.sin(azRad);
        const azZ = AZIMUTH_RADIUS * Math.cos(azRad);
        azimuthHandle.position.set(azX, 0.16, azZ);
        azGlow.position.copy(azimuthHandle.position);

        const elY = CENTER.y + ELEVATION_RADIUS * Math.sin(elRad);
        const elZ = ELEVATION_RADIUS * Math.cos(elRad);
        elevationHandle.position.set(ELEV_ARC_X, elY, elZ);
        elGlow.position.copy(elevationHandle.position);

        const distT = 0.15 + ((10 - liveDistance) / 10) * 0.7;
        distanceHandle.position.lerpVectors(CENTER, cameraIndicator.position, distT);
        distGlow.position.copy(distanceHandle.position);

        updateDistanceLine(CENTER.clone(), cameraIndicator.position.clone());

        const groundProjection = new THREE.Vector3(camX, 0.05, camZ);
        groundMarker.position.copy(groundProjection);

        verticalGuideGeo.setFromPoints([cameraIndicator.position.clone(), groundProjection.clone()]);
        verticalGuide.computeLineDistances();

        const centerGround = new THREE.Vector3(0, 0.05, 0);
        horizontalGuideGeo.setFromPoints([groundProjection.clone(), centerGround.clone()]);
        horizontalGuide.computeLineDistances();

        const elevArcPoint = new THREE.Vector3(ELEV_ARC_X, camY, elZ);
        elevationGuideGeo.setFromPoints([cameraIndicator.position.clone(), elevArcPoint.clone()]);
        elevationGuide.computeLineDistances();
    }

    updateVisuals();

    // Drag interaction
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let isDragging = false;
    let dragTarget = null;
    let hoveredHandle = null;

    function getMousePos(event) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    function setHandleScale(handle, glow, scale) {
        handle.scale.setScalar(scale);
        if (glow) glow.scale.setScalar(scale);
    }

    function onPointerDown(event) {
        getMousePos(event);
        raycaster.setFromCamera(mouse, camera);
        const handles = [
            { mesh: azimuthHandle, glow: azGlow, name: 'azimuth' },
            { mesh: elevationHandle, glow: elGlow, name: 'elevation' },
            { mesh: distanceHandle, glow: distGlow, name: 'distance' }
        ];
        for (const h of handles) {
            if (raycaster.intersectObject(h.mesh).length > 0) {
                isDragging = true;
                dragTarget = h.name;
                setHandleScale(h.mesh, h.glow, 1.3);
                renderer.domElement.style.cursor = 'grabbing';
                return;
            }
        }
    }

    function onPointerMove(event) {
        getMousePos(event);
        raycaster.setFromCamera(mouse, camera);

        if (!isDragging) {
            const handles = [
                { mesh: azimuthHandle, glow: azGlow, name: 'azimuth' },
                { mesh: elevationHandle, glow: elGlow, name: 'elevation' },
                { mesh: distanceHandle, glow: distGlow, name: 'distance' }
            ];
            let foundHover = null;
            for (const h of handles) {
                if (raycaster.intersectObject(h.mesh).length > 0) { foundHover = h; break; }
            }
            if (hoveredHandle && hoveredHandle !== foundHover) setHandleScale(hoveredHandle.mesh, hoveredHandle.glow, 1.0);
            if (foundHover) {
                setHandleScale(foundHover.mesh, foundHover.glow, 1.15);
                renderer.domElement.style.cursor = 'grab';
                hoveredHandle = foundHover;
            } else {
                renderer.domElement.style.cursor = 'default';
                hoveredHandle = null;
            }
            return;
        }

        const plane = new THREE.Plane();
        const intersect = new THREE.Vector3();

        if (dragTarget === 'azimuth') {
            plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0));
            if (raycaster.ray.intersectPlane(plane, intersect)) {
                let angle = Math.atan2(intersect.x, intersect.z) * (180 / Math.PI);
                if (angle < 0) angle += 360;
                liveAzimuth = Math.max(0, Math.min(360, angle));
                state.azimuth = Math.round(liveAzimuth);
                elements.azimuthSlider.value = state.azimuth;
                updateSliderValues();
                updatePromptDisplay();
                updateVisuals();
            }
        } else if (dragTarget === 'elevation') {
            const elevPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -ELEV_ARC_X);
            if (raycaster.ray.intersectPlane(elevPlane, intersect)) {
                const relY = intersect.y - CENTER.y;
                const relZ = intersect.z;
                let angle = Math.atan2(relY, relZ) * (180 / Math.PI);
                angle = Math.max(-30, Math.min(90, angle));
                liveElevation = angle;
                state.elevation = Math.round(liveElevation);
                elements.elevationSlider.value = state.elevation;
                updateSliderValues();
                updatePromptDisplay();
                updateVisuals();
            }
        } else if (dragTarget === 'distance') {
            const newDist = 5 - mouse.y * 5;
            liveDistance = Math.max(0, Math.min(10, newDist));
            state.distance = Math.round(liveDistance * 10) / 10;
            elements.distanceSlider.value = state.distance;
            updateSliderValues();
            updatePromptDisplay();
            updateVisuals();
        }
    }

    function onPointerUp() {
        if (isDragging) {
            const handles = [
                { mesh: azimuthHandle, glow: azGlow },
                { mesh: elevationHandle, glow: elGlow },
                { mesh: distanceHandle, glow: distGlow }
            ];
            handles.forEach(h => setHandleScale(h.mesh, h.glow, 1.0));
        }
        isDragging = false;
        dragTarget = null;
        renderer.domElement.style.cursor = 'default';
    }

    renderer.domElement.addEventListener('mousedown', onPointerDown);
    renderer.domElement.addEventListener('mousemove', onPointerMove);
    renderer.domElement.addEventListener('mouseup', onPointerUp);
    renderer.domElement.addEventListener('mouseleave', onPointerUp);

    renderer.domElement.addEventListener('touchstart', (e) => {
        e.preventDefault();
        onPointerDown({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
    }, { passive: false });
    renderer.domElement.addEventListener('touchmove', (e) => {
        e.preventDefault();
        onPointerMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
    }, { passive: false });
    renderer.domElement.addEventListener('touchend', onPointerUp);

    let time = 0;
    function animate() {
        requestAnimationFrame(animate);
        time += 0.01;
        const pulse = 1 + Math.sin(time * 2) * 0.03;
        camGlow.scale.setScalar(pulse);
        glowRing.rotation.z += 0.003;
        renderer.render(scene, camera);
    }
    animate();

    // 移动端强制刷新尺寸
    setTimeout(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) {
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
        }
    }, 300);

    window.addEventListener('resize', () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    });

    threeScene = {
        updatePositions: () => {
            liveAzimuth = state.azimuth;
            liveElevation = state.elevation;
            liveDistance = state.distance;
            updateVisuals();
        },
        syncFromSliders: () => {
            liveAzimuth = state.azimuth;
            liveElevation = state.elevation;
            liveDistance = state.distance;
            updateVisuals();
        },
        updateImage: (url) => {
            // 清理旧材质，防止内存溢出闪退
            if (planeMat.map) {
                planeMat.map.dispose();
                planeMat.map = null;
            }

            if (url) {
                const img = new Image();
                
                // 解决跨域污染问题
                if (!url.startsWith('data:') && !url.startsWith('blob:')) {
                    img.crossOrigin = 'anonymous';
                } else {
                    img.crossOrigin = null; 
                }

                img.onload = () => {
                    // 最大限制 1024，防 OOM 闪退
                    const MAX_TEX_SIZE = 1024; 
                    let width = img.width;
                    let height = img.height;

                    if (width > MAX_TEX_SIZE || height > MAX_TEX_SIZE) {
                        const ratio = Math.min(MAX_TEX_SIZE / width, MAX_TEX_SIZE / height);
                        width = Math.floor(width * ratio);
                        height = Math.floor(height * ratio);
                    }

                    // 绘制到 Canvas 上
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    const tex = new THREE.CanvasTexture(canvas);
                    
                    // ==========================================
                    // 【终极修复核心】解决除 Bing 外其他手机浏览器不显示的问题
                    // 手机端 WebGL 极其讨厌“非2的幂次方”尺寸的图片。
                    // 必须强制关闭 Mipmaps 并指定 LinearFilter，否则直接渲染失败（黑屏/无画面）。
                    tex.generateMipmaps = false;
                    tex.minFilter = THREE.LinearFilter;
                    tex.magFilter = THREE.LinearFilter;
                    // ==========================================

                    // 兼容旧版/新版 Three.js 的色彩空间
                    if (typeof THREE.SRGBColorSpace !== 'undefined') {
                        tex.colorSpace = THREE.SRGBColorSpace;
                    } else if (typeof THREE.sRGBEncoding !== 'undefined') {
                        tex.encoding = THREE.sRGBEncoding;
                    } else {
                        tex.encoding = 3001; 
                    }
                    
                    tex.needsUpdate = true;
                    planeMat.map = tex;
                    planeMat.color.set(0xffffff);
                    planeMat.needsUpdate = true;
                    
                    // 调整比例面板，防止图片惨遭压扁拉伸
                    const ar = img.width / img.height;
                    const maxSize = 1.5;
                    if (ar > 1) {
                        imagePlane.scale.set(maxSize, maxSize / ar, 1);
                        imageFrame.scale.set(maxSize, maxSize / ar, 1);
                    } else {
                        imagePlane.scale.set(maxSize * ar, maxSize, 1);
                        imageFrame.scale.set(maxSize * ar, maxSize, 1);
                    }
                };
                
                img.onerror = (err) => {
                    console.warn("3D预览贴图加载失败:", err);
                    planeMat.map = null;
                    planeMat.color.set(0xE93D82);
                    planeMat.needsUpdate = true;
                };

                // 注意：必须在定义完 onload 之后再赋值 src，兼容老旧 iOS 内核
                img.src = url;
            } else {
                planeMat.map = null;
                planeMat.color.set(0x3a3a4a);
                planeMat.needsUpdate = true;
                imagePlane.scale.set(1, 1, 1);
                imageFrame.scale.set(1, 1, 1);
            }
        },
        resize: () => {
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (w > 0 && h > 0) {
                camera.aspect = w / h;
                camera.updateProjectionMatrix();
                renderer.setSize(w, h);
                renderer.render(scene, camera); // 立即渲染一帧
            }
        }
    };

    // 让 index.js 可以找到它
    window.threeScene = threeScene; 
}

// ===== Event Listeners =====
function setupEventListeners() {
    // 加入防空指针判断
    if (elements.azimuthSlider) {
        elements.azimuthSlider.addEventListener('input', (e) => {
            state.azimuth = parseFloat(e.target.value);
            updateSliderValues();
            updatePromptDisplay();
            if (threeScene) threeScene.syncFromSliders();
        });
    }
    
    if (elements.elevationSlider) {
        elements.elevationSlider.addEventListener('input', (e) => {
            state.elevation = parseFloat(e.target.value);
            updateSliderValues();
            updatePromptDisplay();
            if (threeScene) threeScene.syncFromSliders();
        });
    }

    if (elements.distanceSlider) {
        elements.distanceSlider.addEventListener('input', (e) => {
            state.distance = parseFloat(e.target.value);
            updateSliderValues();
            updatePromptDisplay();
            if (threeScene) threeScene.syncFromSliders();
        });
    }
}

// ===== Init =====
function init() {
    try {
        elements.threejsContainer = document.getElementById('threejs-container');
        elements.azimuthSlider = document.getElementById('azimuth-slider');
        elements.elevationSlider = document.getElementById('elevation-slider');
        elements.distanceSlider = document.getElementById('distance-slider');
        elements.azimuthValue = document.getElementById('azimuth-value');
        elements.elevationValue = document.getElementById('elevation-value');
        elements.distanceValue = document.getElementById('distance-value');
        elements.promptDisplay = document.getElementById('prompt-display');
        elements.extraPromptInput = document.getElementById('extra-prompt-input');

        // ==== 第一步：不论3D如何，先把UI参数挂载上去 ====
        setupEventListeners();
        updateSliderValues();
        updatePromptDisplay();
    } catch (e) {
        console.error("UI参数面板初始化失败，可能DOM未加载完毕:", e);
        // 如果依然失败，提示用户
        if(elements.promptDisplay) {
            elements.promptDisplay.innerHTML = `<span style="color:red;">参数加载失败，请刷新重试</span>`;
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}