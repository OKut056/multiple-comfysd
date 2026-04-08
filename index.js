let mainState = {
    uploadedImageFile: null,
    uploadedImageFile2: null,
    uploadedImageFile3: null // 统一存储：无论是点击上传还是URL加载的文件对象
};

// Agent接口地址（根据实际部署的Agent地址修改）
const AGENT_API_URL = "/generate";

const NEGATIVE_PROMPT = "/workflow/negative-prompt";

// 切换表单显示/隐藏
function toggleFormFields() {
    const cmdType = document.getElementById("cmd-type").value;
    const genConfig = document.getElementById("gen-config");
    const promptGroup = document.getElementById("prompt-group"); // 获取提示词区域
    const imgUploadGroup = document.getElementById("img-upload-group");
    const imgUploadGroup2 = document.getElementById("img-upload-group-2");
    const imgUploadGroup3 = document.getElementById("img-upload-group-3");
    const modelGroup = document.getElementById("model-select-group");
    const resolutionGroup = document.getElementById("resolution_select_group");
    const multiAngleConfig = document.getElementById("multi-angle-config");     // 多角度面板
    
    // 生成配置文生图/图生图显示
    genConfig.style.display = "block";

    // 多角度图生图时，隐藏提示词输入框
    if (promptGroup) {
        promptGroup.style.display = (cmdType === "img2img_multi") ? "none" : "block";
    }

    // 图生图与多角度图生图，均显示“上传图片（图生图参考）”
    const isImageMode = (cmdType === "img2img" || cmdType === "img2img_multi");
    imgUploadGroup.style.display = isImageMode ? "block" : "none";
    
    // 图生图显示图片上传
    imgUploadGroup2.style.display = cmdType === "img2img" ? "block" : "none";
    imgUploadGroup3.style.display = cmdType === "img2img" ? "block" : "none";

    // 多角度模式下，显示3D与滑块
    // 仅在切换到多角度模式时刷新
    const wasHidden = multiAngleConfig.style.display === "none";
    multiAngleConfig.style.display = (cmdType === "img2img_multi") ? "block" : "none";

    // 模型选择：关键修改点 —— 仅在文生图时显示 flex，其他模式均隐藏
    modelGroup.style.display = (cmdType === "text2img") ? "flex" : "none";

    // 图生图与多角度模式下，隐藏 分辨率
    resolutionGroup.style.display = cmdType === "text2img" ? "flex" : "none";

    // 文生图显示负面提示词，图生图隐藏
    const negGroup = document.getElementById("negative-prompt-group");
    if (negGroup) {
        negGroup.style.display = cmdType === "text2img" ? "block" : "none";
    }

    // 只在从隐藏变为显示时刷新（防止重复刷新导致黑屏）
    // 延迟初始化 + 强制重绘
    if (cmdType === "img2img_multi" && wasHidden) {
        // 先让 DOM 完成渲染
        setTimeout(() => {
            const container = document.getElementById('threejs-container');
            if (!container) return;
            
            // 强制触发布局计算
            container.offsetHeight;
            
            if (!window.threeScene && typeof initThreeJS === 'function') {
                initThreeJS();
            } else if (window.threeScene && window.threeScene.resize) {
                window.threeScene.resize();
            }

            // 修复先传图再选"多角度"无图片预览的BUG
            const previewImg = document.getElementById('preview-image');
            if (window.threeScene && previewImg && previewImg.style.display !== 'none') {
                window.threeScene.updateImage(previewImg.src);
            }

            // 移动端额外刷新
            setTimeout(() => {
                if (window.threeScene && window.threeScene.resize) {
                    window.threeScene.resize();
                }
            }, 300);
        }, 200);
    }
}

// 切换种子输入框显示
function toggleSeedInput() {
    const seedMode = document.getElementById("seed-mode").value;
    const seedInputGroup = document.getElementById("seed-input-group");
    seedInputGroup.style.display = seedMode === "specify" ? "block" : "none";
}

// 构造Agent指令字符串
function buildCommand() {
    const cmdType = document.getElementById("cmd-type").value;
    let prompt = document.getElementById("prompt").value.trim();

    if (cmdType === "img2img_multi") {
        // 从多角度面板中获取 附加提示词 和 滑块的数值
        const extraPrompt = document.getElementById("extra-prompt-input") 
            ? document.getElementById("extra-prompt-input").value.trim() 
            : "";
        const az = document.getElementById("azimuth-slider").value;
        const el = document.getElementById("elevation-slider").value;
        const dist = parseFloat(document.getElementById("distance-slider").value).toFixed(1);
        
        const cameraParams = `方位角:${az}°, 仰角:${el}°, 缩放:${dist}`;
        
        // 生成最终格式，例如： "衣物变更 (视角视角: 方位角:90°, 仰角:0°, 缩放:5.0)"
        prompt = extraPrompt 
            ? `${extraPrompt} (视角视角: ${cameraParams})` 
            : `(视角视角: ${cameraParams})`;
    }

    // 基础指令前缀
    let cmdPrefix = cmdType === "text2img" ? "文生图：" : "图生图：";

    // ── 种子部分（文生图/图生图均有）──
    const seedMode = document.getElementById("seed-mode").value;
    const seedValue = document.getElementById("seed-value").value.trim();
    
    let seedStr = "";
    if (seedMode === "fixed") {
        seedStr = "种子固定";
    } else if (seedMode === "specify" && seedValue) {
        seedStr = `种子：${seedValue}`;
    } else {
        seedStr = "种子随机";
    }

    // ── 文生图：拼接 base/turbo/分辨率 ──
    if (cmdType === "text2img") {
        const baseModel = document.getElementById("base-model").value;
        const turboModel = document.getElementById("turbo-model").value;
        const resWidth = document.getElementById("resolution-width").value.trim();
        const resHeight = document.getElementById("resolution-height").value.trim();

        const paramStr = `base=${baseModel},turbo=${turboModel},${seedStr},分辨率：${resWidth}x${resHeight}`;
        return `${cmdPrefix}${prompt}|${paramStr}`;
    }

    // ── 图生图：只拼接种子 ──
    return `${cmdPrefix}${prompt}|${seedStr}`;
}

function initEnhancedUpload() {
    const uploadZone = document.getElementById('upload-zone');
    const imageInput = document.getElementById('image-file'); // 原始隐藏的file input
    const previewImg = document.getElementById('preview-image');
    const placeholder = document.getElementById('upload-placeholder');
    const clearBtn = document.getElementById('clear-image');

    // 1. 点击区域触发文件选择
    uploadZone.addEventListener('click', () => imageInput.click());

    // 2. 监听文件选择框的变化
    imageInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFile(e.target.files[0]);
        }
    });

    // 3. 拖拽支持 (Drag & Drop)
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('drag-over');
    });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('drag-over');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    // 4. 清除预览 (点击右上角 X)
    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // 防止触发父级的点击上传
        mainState.uploadedImageFile = null;
        imageInput.value = '';
        previewImg.src = '';
        previewImg.style.display = 'none';
        placeholder.style.display = 'flex';
        clearBtn.style.display = 'none';

        // 清除时同步清空 3D 画布中的图片
        if (window.threeScene) {
            window.threeScene.updateImage(null);
        }
    });

    // 处理文件并更新 UI 预览
    function handleFile(file) {
        if (!file.type.startsWith('image/')) return alert('请选择图片格式文件！');
        
        mainState.uploadedImageFile = file; 
        const reader = new FileReader();
        reader.onload = (e) => {
            const previewImg = document.getElementById('preview-image');
            const placeholder = document.getElementById('upload-placeholder');
            const clearBtn = document.getElementById('clear-image');

            // 【解决闪退核心1：释放上一张旧图片的内存指针】
            if (previewImg.src && previewImg.src.startsWith('blob:')) {
                URL.revokeObjectURL(previewImg.src);
            }
            
            // 【解决闪退核心2：零内存拷贝直接读取文件】
            const objectUrl = URL.createObjectURL(file);
            previewImg.src = objectUrl;
            
            // 核心修复逻辑
            previewImg.style.display = 'block'; 
            placeholder.style.display = 'none';
            
            // 关键点：使用 setProperty 来覆盖 !important 样式
            clearBtn.style.setProperty('display', 'flex', 'important'); 

            // 如果处于多角度模式，将图片推送到 Three.js
            const cmdType = document.getElementById("cmd-type").value;
            if (cmdType === "img2img_multi" && window.threeScene) {
                window.threeScene.updateImage(e.target.result);
            }
        };
        reader.readAsDataURL(file);
    }

    // 补充：确保“清除”点击事件正常工作
    document.getElementById('clear-image').onclick = function(e) {
        e.stopPropagation(); // 阻止冒泡，防止触发父级上传点击
        mainState.uploadedImageFile = null;
        
        // 重置输入框
        document.getElementById('image-file').value = '';
        
        // 恢复 UI 状态
        document.getElementById('preview-image').src = '';
        document.getElementById('preview-image').style.display = 'none';
        document.getElementById('upload-placeholder').style.display = 'flex';
        
        // 隐藏清除按钮本身：使用 important 确保消失
        this.style.setProperty('display', 'none', 'important'); 
    };
}

// 提交请求到Agent
async function submitRequest() {
    // 基础校验
    const cmdType = document.getElementById("cmd-type").value;
    const prompt = document.getElementById("prompt").value.trim();
    // 如果不是多角度模式，且提示词为空，则拦截提示
    if (!prompt && cmdType !== "img2img_multi") {
        alert("请输入提示词/聊天内容！");
        return;
    }

    // 元素获取
    const submitBtn = document.getElementById("submit-btn");
    const loading = document.getElementById("loading");
    const resultContent = document.getElementById("result-content");
    
    // 状态切换
    submitBtn.disabled = true;
    loading.style.display = "block";
    resultContent.innerHTML = "";

    try {
        // 构造FormData
        const formData = new FormData();
        const command = buildCommand();
        formData.append("command", command);

        // 追加负面提示词（文生图时有效）
        const negPrompt = document.getElementById("negative-prompt")?.value.trim() || "";
        formData.append("negative_prompt", negPrompt);

        // 图生图添加图片文件
        if (document.getElementById("cmd-type").value === "img2img" || 
            document.getElementById("cmd-type").value === "img2img_multi") {
            const imageFile = mainState.uploadedImageFile; // 改为从全局状态获取
            if (!imageFile) {
                alert("图生图模式必须上传图片文件或加载URL！");
                return; // 终止执行
            }
            if (imageFile.size > 20 * 1024 * 1024) {
                throw new Error("图片文件不能超过 20MB！");
            }
            const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
            if (!allowedTypes.includes(imageFile.type)) {
                throw new Error("仅支持 JPG / PNG / WebP 格式图片！");
            }
            formData.append("image_file", imageFile);

            // 图生图追加图2（可选）
            if (mainState.uploadedImageFile2) {
                if (mainState.uploadedImageFile2.size > 20 * 1024 * 1024) {
                    throw new Error("参考图2文件不能超过 20MB！");
                }
                formData.append("image_file_2", mainState.uploadedImageFile2);
            }

            // 图生图追加图3（可选）
            if (mainState.uploadedImageFile3) {
                if (mainState.uploadedImageFile3.size > 20 * 1024 * 1024) {
                    throw new Error("参考图3文件不能超过 20MB！");
                }
                formData.append("image_file_3", mainState.uploadedImageFile3);
            }
        }

        // 调用Agent接口
        const response = await fetch( AGENT_API_URL , {
            method: "POST",
            body: formData
        });

        // 先拿原始文本，再解析
        const rawText = await response.text();
        console.log("[DEBUG] 原始响应:", rawText);

        let result;
        try {
            result = JSON.parse(rawText);
        } catch(e) {
            resultContent.innerHTML = `<div class="message-item agent-msg"><div class="msg-content error">❌ 响应解析失败：${rawText || '空响应'}</div></div>`;
            return;
        }

        // 渲染结果
        renderResult(result, command);
    } catch (error) {
        resultContent.innerHTML = `
            <div class="message-item agent-msg">
                <div class="msg-content error">
                    ❌ 请求失败：${error.message}
                </div>
            </div>
        `;
    } finally {
        // 恢复状态
        submitBtn.disabled = false;
        loading.style.display = "none";
    }
}

// 渲染返回结果
function renderResult(result, command) {
    const resultContent = document.getElementById("result-content");
    
    // 先渲染用户指令
    let html = `
        <div class="message-item user-msg">
            <div class="msg-content">
                <strong>你的指令：</strong><br>${command}
            </div>
        </div>
    `;

    // 渲染Agent响应
    if (result.status === "success") {
        html += `
            <div class="message-item agent-msg">
                <div class="msg-content success">
                    ${result.message}
                </div>
        `;

        // 生成成功且有预览图
        if (result.preview_url) {
            html += `
                <div class="seed-info">
                    <strong>种子信息：</strong>${result.seed}（模式：${result.seed_mode}）<br>
                </div>
                <img src="${result.preview_url}" class="preview-img" alt="生成结果">
            `;
        }
        html += `</div>`;
    } else {
        html += `
            <div class="message-item agent-msg">
                <div class="msg-content error">
                    ${result.message}
                </div>
            </div>
        `;
    }

    resultContent.innerHTML = html;
}

// 页面加载时，从工作流读取负面提示词并填入框中
async function loadNegativePrompt() {
    try {
        const resp = await fetch(NEGATIVE_PROMPT);
        const data = await resp.json();
        if (data.status === "success" && data.negative_prompt) {
            document.getElementById("negative-prompt").value = data.negative_prompt;
        }
    } catch (e) {
        console.warn("加载负面提示词失败：", e);
    }
}

// 用户点击"保存"按钮，将负面提示词写回工作流文件
async function saveNegativePrompt() {
    const negPrompt = document.getElementById("negative-prompt").value.trim();
    const btn  = document.getElementById("save-neg-btn");
    const tip  = document.getElementById("neg-save-tip");

    btn.disabled = true;
    btn.textContent = "保存中...";

    try {
        const resp = await fetch(NEGATIVE_PROMPT, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ negative_prompt: negPrompt }),
        });
        const data = await resp.json();
        if (data.status === "success") {
            tip.style.display = "inline";
            setTimeout(() => { tip.style.display = "none"; }, 3000);
        } else {
            alert("保存失败：" + data.message);
        }
    } catch (e) {
        alert("请求失败：" + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = "💾 保存";
    }
}

// 关机函数
async function powerOff() {
    // 二次确认，防止误触
    const confirmed = confirm("⚠️ 确认要关闭云端实例吗？\n关机后生成功能将无法使用，需重新开机。");
    if (!confirmed) return;

    const btn = document.getElementById("power-off-btn");
    btn.disabled = true;
    btn.textContent = "关机中...";

    try {
        const response = await fetch("power-off", {
            method: "POST",
        });
        const result = await response.json();

        if (result.status === "success") {
            btn.textContent = "✅ 已关机";
            btn.style.backgroundColor = "#67c23a";
            alert("✅ 云端实例关机指令已发送成功！");
        } else {
            btn.disabled = false;
            btn.textContent = "⏻ 关机";
            alert("❌ 关机失败：" + result.message);
        }
    } catch (error) {
        btn.disabled = false;
        btn.textContent = "⏻ 关机";
        alert("❌ 请求失败：" + error.message);
    }
}

// 开机函数
async function powerOn() {
    // 二次确认，防止误触
    const confirmed = confirm("⚠️ 确认要开启云端实例吗？\n开机后将开始计费。");
    if (!confirmed) return;

    const btn = document.getElementById("power-on-btn");
    btn.disabled = true;
    btn.textContent = "开机中...";

    try {
        const response = await fetch("power-on", {
            method: "POST",
        });
        const result = await response.json();

        if (result.status === "success") {
            btn.textContent = "✅ 已开机";
            btn.style.backgroundColor = "#67c23a";
            alert("✅ 云端实例开机指令已发送成功！");
        } else {
            btn.disabled = false;
            btn.textContent = "⏻ 开机";
            alert("❌ 开机失败：" + result.message);
        }
    } catch (error) {
        btn.disabled = false;
        btn.textContent = "⏻ 开机";
        alert("❌ 请求失败：" + error.message);
    }
}

// 状态标签映射
const STATUS_MAP = {
    "running":  { icon: "🟢", text: "运行中" },
    "shutdown": { icon: "🔴", text: "已关机" },
    "starting": { icon: "🟡", text: "启动中" },
    "stopping": { icon: "🟡", text: "关机中" },
    "error":    { icon: "⚠️", text: "异常"   },
    "unknown":  { icon: "❓", text: "未知"   },
};

async function fetchInstanceStatus() {
    try {
        const resp = await fetch("/instance-status");
        const result = await resp.json();
        if (result.status === "success") {
            const t = STATUS_MAP[result.data.text2img] || STATUS_MAP["unknown"];
            const i = STATUS_MAP[result.data.img2img]  || STATUS_MAP["unknown"];
            document.getElementById("status-text2img").textContent =
                `${t.icon} 文生图实例：${t.text}`;
            document.getElementById("status-img2img").textContent =
                `${i.icon} 图生图实例：${i.text}`;
        }
    } catch (e) {
        document.getElementById("status-text2img").textContent = "⚠️ 文生图实例：检测失败";
        document.getElementById("status-img2img").textContent  = "⚠️ 图生图实例：检测失败";
    }

    // 随机间隔 3~10 秒后再次检测
    const delay = (3 + Math.floor(Math.random() * 7)) * 1000;
    setTimeout(fetchInstanceStatus, delay);
}

async function fetchQueueStatus() {
    const t2i = document.getElementById("queue-text2img");
    const i2i = document.getElementById("queue-img2img");
    try {
        const resp = await fetch("/queue-status");
        const result = await resp.json();
        if (result.status === "success") {
            const d = result.data;

            // 文生图
            if (d.text2img.total === -1) {
                t2i.textContent = "⚠️ 文生图队列：实例离线";
                t2i.style.color = "#f56c6c";
            } else if (d.text2img.total === 0) {
                t2i.textContent = "✅ 文生图队列：空闲";
                t2i.style.color = "#52c41a";
            } else {
                t2i.textContent = `⏳ 文生图队列：运行 ${d.text2img.running} | 等待 ${d.text2img.pending}`;
                t2i.style.color = "#e6a23c";
            }

            // 图生图
            if (d.img2img.total === -1) {
                i2i.textContent = "⚠️ 图生图队列：实例离线";
                i2i.style.color = "#f56c6c";
            } else if (d.img2img.total === 0) {
                i2i.textContent = "✅ 图生图队列：空闲";
                i2i.style.color = "#52c41a";
            } else {
                i2i.textContent = `⏳ 图生图队列：运行 ${d.img2img.running} | 等待 ${d.img2img.pending}`;
                i2i.style.color = "#e6a23c";
            }
        }
    } catch (e) {
        t2i.textContent = "⚠️ 文生图队列：检测失败";
        i2i.textContent = "⚠️ 图生图队列：检测失败";
    }

    // 提交中时缩短轮询间隔，空闲时拉长
    const submitBtn = document.getElementById("submit-btn");
    const delay = submitBtn.disabled ? 3000 : 8000;
    setTimeout(fetchQueueStatus, delay);
}

// 折叠/展开函数
function toggleRefImage(index) {
    const checkbox = document.getElementById(`ref${index}-checkbox`);
    const content = document.getElementById(`ref${index}-content`);
    const arrow = document.getElementById(`ref${index}-arrow`);

    if (content.style.display === 'none' || content.style.display === '') {
        content.style.display = 'block';
        arrow.style.transform = 'rotate(180deg)';
        checkbox.checked = true;
    } else {
        content.style.display = 'none';
        arrow.style.transform = 'rotate(0deg)';
        checkbox.checked = false;
    }
}

// 初始化参考图2上传
function initRefImage2Upload() {
    const uploadZone = document.getElementById('upload-zone-2');
    const imageInput = document.getElementById('image-file-2');
    const previewImg = document.getElementById('preview-image-2');
    const placeholder = document.getElementById('upload-placeholder-2');
    const clearBtn = document.getElementById('clear-image-2');

    uploadZone.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFile(e.target.files[0]);
        }
    });

    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('drag-over');
    });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('drag-over');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        mainState.uploadedImageFile2 = null;
        imageInput.value = '';
        previewImg.src = '';
        previewImg.style.display = 'none';
        placeholder.style.display = 'flex';
        clearBtn.style.display = 'none';
    });

    function handleFile(file) {
        if (!file.type.startsWith('image/')) return alert('请选择图片格式文件！');
        mainState.uploadedImageFile2 = file;

        const previewImg = document.getElementById('preview-image-2');
        const placeholder = document.getElementById('upload-placeholder-2');
        const clearBtn = document.getElementById('clear-image-2');

        if (previewImg.src && previewImg.src.startsWith('blob:')) {
            URL.revokeObjectURL(previewImg.src);
        }
        const objectUrl = URL.createObjectURL(file);
        
        previewImg.src = objectUrl;
        previewImg.style.display = 'block';
        placeholder.style.display = 'none';
        clearBtn.style.setProperty('display', 'flex', 'important');
    }
}

// 初始化参考图3上传
function initRefImage3Upload() {
    const uploadZone = document.getElementById('upload-zone-3');
    const imageInput = document.getElementById('image-file-3');
    const previewImg = document.getElementById('preview-image-3');
    const placeholder = document.getElementById('upload-placeholder-3');
    const clearBtn = document.getElementById('clear-image-3');

    uploadZone.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFile(e.target.files[0]);
        }
    });

    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('drag-over');
    });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('drag-over');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        mainState.uploadedImageFile3 = null;
        imageInput.value = '';
        previewImg.src = '';
        previewImg.style.display = 'none';
        placeholder.style.display = 'flex';
        clearBtn.style.display = 'none';
    });

    function handleFile(file) {
        if (!file.type.startsWith('image/')) return alert('请选择图片格式文件！');
        mainState.uploadedImageFile3 = file;

        const previewImg = document.getElementById('preview-image-3');
        const placeholder = document.getElementById('upload-placeholder-3');
        const clearBtn = document.getElementById('clear-image-3');

        if (previewImg.src && previewImg.src.startsWith('blob:')) {
            URL.revokeObjectURL(previewImg.src);
        }
        const objectUrl = URL.createObjectURL(file);

        previewImg.src = objectUrl;
        previewImg.style.display = 'block';
        placeholder.style.display = 'none';
        clearBtn.style.setProperty('display', 'flex', 'important');
    }
}

// ══════════════ 公告系统 ══════════════

let _noticeData = null;   // 缓存公告数据

/** 页面加载时拉取并展示公告 */
async function loadNotice() {
    try {
        const resp = await fetch("/notice");
        const result = await resp.json();

        if (result.status !== "success") return;
        const data = result.data;
        if (!data.enabled || !data.content) return;  // 管理员关闭或无内容时不显示

        _noticeData = data;
        renderNotice(data);
        openNoticeModal();   // 自动弹出
    } catch (e) {
        console.warn("公告加载失败：", e);
    }
}

/** 渲染公告内容到DOM */
function renderNotice(data) {
    document.getElementById("notice-title").textContent   = data.title   || "📢 系统公告";
    document.getElementById("notice-content").textContent = data.content || "";
    document.getElementById("notice-updated").textContent =
        data.updated_at ? `更新于：${data.updated_at}` : "";
}

/** 打开弹窗 */
function openNoticeModal() {
    if (!_noticeData) return;
    renderNotice(_noticeData);
    document.getElementById("notice-modal").style.display = "block";
    document.getElementById("notice-float").style.display = "none";
}

/** 关闭弹窗 → 显示悬浮窗 */
function closeNoticeModal() {
    document.getElementById("notice-modal").style.display = "none";
    document.getElementById("notice-float").style.display = "flex";
}

// 点击遮罩也可关闭
document.getElementById("notice-overlay")?.addEventListener("click", closeNoticeModal);

// 初始化
window.onload = function() {
    toggleFormFields();
    toggleSeedInput();
    loadNegativePrompt();
    fetchInstanceStatus();
    fetchQueueStatus();
    loadNotice();
    initEnhancedUpload();
    initRefImage2Upload();
    initRefImage3Upload();
};