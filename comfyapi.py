import os
import json
import time
import uuid
import random
import uvicorn
import requests
from typing import Optional
from urllib3.util.retry import Retry
from contextlib import contextmanager
from requests.adapters import HTTPAdapter
from urllib.parse import quote, unquote, urlparse
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, UploadFile, File, Form, Response, Request
import asyncio
_workflow_lock = asyncio.Lock()

# =============================================================================
# 全局变量
# =============================================================================

# 使用 LRU 限制大小
from collections import OrderedDict

class LRUDict(OrderedDict):
    def __init__(self, max_size=500):
        super().__init__()
        self.max_size = max_size
    def __setitem__(self, key, value):
        if key in self:
            self.move_to_end(key)
        super().__setitem__(key, value)
        if len(self) > self.max_size:
            self.popitem(last=False)

_user_seeds: LRUDict = LRUDict(max_size=500)

_http_session: requests.Session = None

def get_global_session() -> requests.Session:
    global _http_session
    if _http_session is None or not _http_session.adapters:
        _http_session = get_session()
    return _http_session

# ---------- AutoDL 配置 ----------
T_AUTODL_INSTANCE_UUID = "*****"
I_AUTODL_INSTANCE_UUID = "*****"
AUTODL_TOKEN = (
    "*****"
)
AUTODL_POWER_OFF_URL = "https://www.autodl.art/api/v1/adl_dev/dev/instance/pro/power_off"
AUTODL_POWER_ON_URL = "https://www.autodl.art/api/v1/adl_dev/dev/instance/pro/power_on"

# =============================================================================
# 1. 核心配置
# =============================================================================

class Config:
    # ---------- AutoDL 云端地址 ----------
    # ---------- 文生图实例（AutoDL 实例A） ----------
    TEXT2IMG_JUPYTER_URL = "*****"
    TEXT2IMG_COMFYUI_API_URL = "*****"

    # ---------- 图生图实例（AutoDL 实例B） ----------
    IMG2IMG_JUPYTER_URL       = "*****"
    IMG2IMG_COMFYUI_API_URL   = "*****"

     # ---------- 按类型取对应地址的工具方法 ----------
    @classmethod
    def get_comfyui_api_url(cls, task_type: str) -> str:
        return cls.IMG2IMG_COMFYUI_API_URL if task_type == "img2img" else cls.TEXT2IMG_COMFYUI_API_URL

    @classmethod
    def get_jupyter_url(cls, task_type: str) -> str:
        return cls.IMG2IMG_JUPYTER_URL if task_type == "img2img" else cls.TEXT2IMG_JUPYTER_URL

    # ---------- 本地后端地址 ----------
    BACKEND_HOST = "*****"

    # ---------- Jupyter 鉴权 Cookie ----------
    # ⚠️ 若图片无法显示，请在浏览器登录 Jupyter 后抓包替换
    TEXT2IMG_JUPYTER_COOKIE = (
        '*****'
    )
    IMG2IMG_JUPYTER_COOKIE  = (
        '*****'
    )
    TEXT2IMG_XSRF_TOKEN = "*****"
    IMG2IMG_XSRF_TOKEN = "*****"

    # ---------- 工作流文件路径 ----------
    WORKFLOW_PATHS = {
        "z_image":   "/www/wwwroot/comfysd/workflows/Z-Image_双重采样工作流.json",
        "qwen_edit": "/www/wwwroot/comfysd/workflows/Qwen-Imag-Eedit-2511-4steplora图像编辑.json",
    }

    # ---------- 种子参数名（兼容各类工作流节点） ----------
    SEED_PARAM_NAMES = ["seed", "noise_seed", "random_seed", "latent_seed"]

    # ---------- Z-Image 模型路径映射 ----------
    Z_IMAGE_BASE_MODELS = {
        1: "z_image_bf16.safetensors",
        2: "zib/moodyWildMix_v10Base50steps.safetensors",
        3: "zib/radianceZ_v10.safetensors",
    }
    Z_IMAGE_TURBO_MODELS = {
        1: "z_image_turbo_bf16.safetensors",
        2: "zit/moodyPornMix_zitV8.safetensors",
        3: "zit/pornmasterZImage_turboV1.safetensors",
        4: "zit/zImageTurboNSFW_43BF16Diffusion.safetensors",
    }

    # ---------- ComfyUI 输出目录（与云端一致） ----------
    COMFYUI_OUTPUT_DIR = "ComfyUI/output"

# =============================================================================
# 2. 工作流工具函数
# =============================================================================

def get_session() -> requests.Session:
    """
    创建带重试策略的 Session，复用 TCP 连接，
    避免频繁建立新连接触发云端限制
    """
    session = requests.Session()
    retry_strategy = Retry(
        total=3,                        # 最多重试 3 次
        backoff_factor=2,               # 退避因子：1s, 2s, 4s, 8s, 16s
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET", "POST"],
        raise_on_status=False,
    )
    adapter = HTTPAdapter(
        max_retries=retry_strategy,
        pool_connections=5,             # 连接池大小
        pool_maxsize=10,
    )
    session.mount("https://", adapter)
    session.mount("http://",  adapter)
    return session

def load_workflow(workflow_type: str) -> dict:
    """从本地 workflows 目录加载工作流 JSON，并确保包裹在 {"prompt": ...} 中"""
    path = Config.WORKFLOW_PATHS.get(workflow_type)
    if not path or not os.path.exists(path):
        raise FileNotFoundError(f"工作流文件不存在：{path}")
    with open(path, "r", encoding="utf-8") as f:
        workflow = json.load(f)
    if "prompt" not in workflow:
        workflow = {"prompt": workflow}
    return workflow

def save_workflow(workflow_type: str, workflow: dict):
    """将修改后的工作流保存回本地 JSON 文件"""
    path = Config.WORKFLOW_PATHS.get(workflow_type)
    if not path:
        raise FileNotFoundError(f"未找到工作流类型：{workflow_type}")
    # 保存的是 prompt 内层内容（与原始文件格式一致）
    with open(path, "w", encoding="utf-8") as f:
        json.dump(workflow["prompt"], f, ensure_ascii=False, indent=2)

def replace_z_image_model(workflow: dict, base_model_id: int, turbo_model_id: int) -> dict:
    """替换 Z-Image 工作流中 UNETLoader 节点的 base / turbo 模型路径"""
    base_path  = Config.Z_IMAGE_BASE_MODELS.get(base_model_id)
    turbo_path = Config.Z_IMAGE_TURBO_MODELS.get(turbo_model_id)
    if not base_path or not turbo_path:
        raise ValueError(f"模型ID无效：base={base_model_id}, turbo={turbo_model_id}")

    for node_id, node in workflow["prompt"].items():
        if node.get("class_type") != "UNETLoader":
            continue
        current_name = node["inputs"].get("unet_name", "").lower()
        # 通过文件名关键词区分 base 和 turbo 节点
        if "turbo" in current_name:
            workflow["prompt"][node_id]["inputs"]["unet_name"] = turbo_path
        else:
            workflow["prompt"][node_id]["inputs"]["unet_name"] = base_path

    return workflow

def replace_prompt(workflow: dict, prompt_text: str, negative_prompt: str = "") -> dict:
    """
    ✅ 修复版：精准替换工作流中的正向/负向提示词
    
    识别规则（针对 Z-Image 文生图工作流）：
      正向节点：CLIPTextEncode 且 _meta.title == "正向"
      负向节点：CLIPTextEncode 且 _meta.title != "正向"（即 title="CLIP文本编码"）
    
    图生图工作流（Qwen）：
      TextEncodeQwenImageEditPlus 且 title="正向" 或 prompt="123444"
    """
    nodes = workflow.get("prompt", workflow)

    for node_id, node in nodes.items():
        class_type = node.get("class_type", "")
        meta       = node.get("_meta", {})
        title      = meta.get("title", "")
        inputs     = node.get("inputs", {})

        # ── 文生图：CLIPTextEncode 节点 ─────────────────────────────────────
        if class_type == "CLIPTextEncode":
            if title == "正向":
                # ✅ 核心修复：用 title 精准定位正向节点，直接覆盖（不再判断是否为空）
                nodes[node_id]["inputs"]["text"] = prompt_text
            else:
                # 负向节点：有传入负面提示词才替换，否则保留工作流默认值
                if negative_prompt:
                    nodes[node_id]["inputs"]["text"] = negative_prompt

        # ── 图生图：Qwen 图像编辑节点 ────────────────────────────────────────
        elif class_type == "TextEncodeQwenImageEditPlus":
            if title == "正向" or inputs.get("prompt") == "123444":
                nodes[node_id]["inputs"]["prompt"] = prompt_text

    return workflow

def replace_seed(workflow: dict, seed_mode: str, seed_value: int = None, user_id: str = "default"):
    """
    替换工作流中所有种子参数。
    返回：(修改后的 workflow, 最终使用的 seed 值)
    """
    global _user_seeds

    if seed_mode == "specify":
        final_seed = seed_value
        _user_seeds[user_id] = final_seed
    elif seed_mode == "fixed":
        if user_id not in _user_seeds:
            _user_seeds[user_id] = random.randint(1, 999_999_999_999)
        final_seed = _user_seeds[user_id]
    else:  # random
        final_seed = random.randint(1, 999_999_999_999)
        _user_seeds.pop(user_id, None)  # 只清自己的

    for seed_param in Config.SEED_PARAM_NAMES:
        for node_id, node in workflow["prompt"].items():
            if seed_param in node.get("inputs", {}):
                workflow["prompt"][node_id]["inputs"][seed_param] = final_seed

    return workflow, final_seed

def replace_resolution(workflow: dict, width: int, height: int) -> dict:
    """替换工作流中 EmptyLatentImage 节点的宽高"""
    for node_id, node in workflow["prompt"].items():
        if node.get("class_type") == "EmptyLatentImage":
            workflow["prompt"][node_id]["inputs"]["width"]  = width
            workflow["prompt"][node_id]["inputs"]["height"] = height
    return workflow

def upload_image_to_comfyui(image_bytes: bytes, filename: str, mimetype: str, task_type: str = "img2img") -> str:
    """将前端上传的图片字节流转发至 ComfyUI，返回云端文件名"""
    upload_url = f"{Config.get_comfyui_api_url(task_type)}upload/image"
    print(f"[DEBUG] 上传图片到：{upload_url}, 文件名：{filename}, 大小：{len(image_bytes)}")

    if not image_bytes:
        raise ValueError("图片内容为空，请重新上传")
    
    # 生成唯一文件名，避免并发覆盖，如启用，下方的"overwrite"需设为false
    ext           = os.path.splitext(filename)[-1] or ".png"
    unique_name   = f"{uuid.uuid4().hex}{ext}"   # 如：a3f8c1d2e4b5.png

    # 独立 session，不用全局
    session = get_session()
    files = {
        "image": (unique_name, image_bytes, mimetype),
    }
    data = {
        "type":      "input",
        "overwrite": "true",
    }
    try:
        resp = session.post(
            upload_url,
            files=files,
            data=data,
            timeout=60,
        )
        print(f"[DEBUG] 上传响应 status={resp.status_code}, body={resp.text[:200]}")
    except requests.exceptions.ConnectionError:
        # 重建的是局部 session，不影响其他请求
        session = get_session()
        resp = session.post(
            upload_url,
            files=files,
            data=data,
            timeout=60,
        )
    finally:
        session.close() 

    if resp.status_code == 200:
        try:
            result = resp.json()
        except Exception:
            raise Exception(f"ComfyUI 上传接口返回非 JSON，状态码 200，响应内容：{resp.text[:300]}")
        uploaded_name = result.get("name")
        if not uploaded_name:
            raise Exception(f"ComfyUI 未返回文件名，响应：{result}")
        return unique_name
    raise Exception(f"图片上传失败 HTTP {resp.status_code}：{resp.text[:300]}")

async def run_comfyui_workflow(workflow: dict, task_type: str = "text2img") -> dict:
    """
    提交工作流到 ComfyUI 并轮询等待完成。
    返回：{"filename": str, "subfolder": str}
    """
    api_url   = Config.get_comfyui_api_url(task_type)
    prompt_url  = f"{api_url}prompt"
    history_url = f"{api_url}history"

    session   = get_global_session()
    prompt_id = str(uuid.uuid4())
    payload = {
        "prompt_id": prompt_id,
        "prompt":    workflow["prompt"],
        "client_id": "comfyapi",
    }

    try:
        resp = session.post(prompt_url, json=payload, timeout=30)
    except requests.exceptions.ConnectionError:
        session = get_session()
        resp = session.post(prompt_url, json=payload, timeout=30)

    if resp.status_code != 200:
        raise Exception(f"提交工作流失败 {resp.status_code}：{resp.text}")

    # 轮询历史记录，最长等待 5 分钟
    deadline = time.time() + 300
    retry_count   = 0
    max_dns_retry = 3  # DNS 失败最多重试 3 次

    while time.time() < deadline:
        try:
            hist_resp = session.get(
                f"{history_url}/{prompt_id}", 
                timeout=(10, 30)
            )
            if hist_resp.status_code == 200:
                history = hist_resp.json()
                if prompt_id in history and "outputs" in history[prompt_id]:
                    for node_output in history[prompt_id]["outputs"].values():
                        if "images" in node_output:
                            img_info = node_output["images"][0]
                            return {
                                "filename":  img_info["filename"],
                                "subfolder": img_info.get("subfolder", ""),
                            }
            retry_count = 0   # 请求成功，重置 DNS 重试计数
            await asyncio.sleep(2)
        except (requests.exceptions.ConnectionError,
                requests.exceptions.SSLError,
                requests.exceptions.Timeout) as e:
            retry_count += 1
            print(f"[WARN] 连接失败（第 {retry_count} 次）：{e}")

            if retry_count >= max_dns_retry:
                raise Exception(
                    f"连接云端失败超过 {max_dns_retry} 次，请检查网络或云端实例状态"
                )

            _http_session = None        # ← 连接异常时重置，下次自动重建
            # 重建局部 Session 后等待更长时间再重试
            session = get_global_session()
            wait_time = 5 * retry_count   # 5s, 10s, 15s 递增等待
            print(f"[INFO] 重建 Session，等待 {wait_time}s 后重试...")
            await asyncio.sleep(wait_time)

    raise TimeoutError("生成超时（超过 5 分钟）")

# autodl关机函数
def autodl_remote_power_off(token: str) -> dict:
    """调用 AutoDL API 关闭云端实例"""
    headers = {
        "Authorization": token,
        "Content-Type": "application/json",
    }
    results = {}
    for name, uuid in [("text2img", T_AUTODL_INSTANCE_UUID), ("img2img", I_AUTODL_INSTANCE_UUID)]:
        try:
            resp = requests.post(
                url=AUTODL_POWER_OFF_URL,
                headers=headers,
                data=json.dumps({"instance_uuid": uuid}),
                timeout=10,
            )
            resp.raise_for_status()
            results[name] = resp.json()
        except requests.exceptions.RequestException as e:
            results[name] = {"error": str(e)}
    return results

# autodl开机函数
def autodl_remote_power_on(token: str) -> dict:
    """调用 AutoDL API 开启云端实例"""
    headers = {
        "Authorization": token,
        "Content-Type": "application/json",
    }
    results = {}
    for name, uuid in [("text2img", T_AUTODL_INSTANCE_UUID), ("img2img", I_AUTODL_INSTANCE_UUID)]:
        try:
            resp = requests.post(
                url=AUTODL_POWER_ON_URL,
                headers=headers,
                data=json.dumps({"instance_uuid": uuid, "payload": "gpu"}),
                timeout=10,
            )
            resp.raise_for_status()
            results[name] = resp.json()
        except requests.exceptions.RequestException as e:
            results[name] = {"error": str(e)}
    return results
    
# =============================================================================
# 3. 指令解析
# =============================================================================

def parse_user_command(command: str) -> dict:
    """
    解析前端构造的指令字符串，格式：
      文生图：<提示词>|base=1,turbo=2,种子随机,分辨率：1080x1920
      图生图：<提示词>|种子固定
    """
    command = command.strip()
    result = {
        "type":           "chat",
        "prompt":         "",
        "base_model_id":  1,
        "turbo_model_id": 1,
        "seed_mode":      "random",
        "seed_value":     None,
        "width":          1080,
        "height":         1920,
        "error":          "",
    }

    if not (command.startswith("文生图：") or command.startswith("图生图：")):
        return result

    result["type"] = "text2img" if command.startswith("文生图：") else "img2img"
    content = command.replace("文生图：", "").replace("图生图：", "").strip()

    prompt_part, param_part = content, ""
    if "|" in content:
        prompt_part, param_part = content.split("|", 1)
        prompt_part = prompt_part.strip()
        param_part  = param_part.strip()

    result["prompt"] = prompt_part

    if param_part:
        param_part = param_part.replace("，", ",").replace("模型：", "")
        for param in param_part.split(","):
            param = param.strip()
            if param.startswith("base="):
                try:
                    result["base_model_id"] = int(param[5:])
                except ValueError:
                    result["error"] = "base 模型ID 必须是数字（1-3）"
            elif param.startswith("turbo="):
                try:
                    result["turbo_model_id"] = int(param[6:])
                except ValueError:
                    result["error"] = "turbo 模型ID 必须是数字（1-4）"
            elif param.startswith("种子："):
                try:
                    result["seed_mode"]  = "specify"
                    result["seed_value"] = int(param[3:])
                except ValueError:
                    result["error"] = "种子必须是整数（如：种子：123456）"
            elif param == "种子固定":
                result["seed_mode"] = "fixed"
            elif param == "种子随机":
                result["seed_mode"] = "random"
            elif param.startswith("分辨率："):
                try:
                    w, h = param[4:].split("x")
                    result["width"], result["height"] = int(w), int(h)
                    if result["width"] % 2 or result["height"] % 2:
                        result["error"] = "分辨率宽高必须为偶数"
                except Exception:
                    result["error"] = "分辨率格式错误（示例：分辨率：1080x1920）"

    if result["base_model_id"] not in Config.Z_IMAGE_BASE_MODELS:
        result["error"] = "base 模型ID 超出范围（1-3）"
    if result["turbo_model_id"] not in Config.Z_IMAGE_TURBO_MODELS:
        result["error"] = "turbo 模型ID 超出范围（1-4）"

    return result

# =============================================================================
# 4. Agent 核心处理
# =============================================================================

async def agent_handle(
    command:         str,
    negative_prompt: str   = "",
    image_bytes:     bytes = None,
    image_filename:  str   = None,
    image_mimetype:  str   = None,
    user_id:         str   = "default",
) -> dict:
    """解析指令 → 修改工作流 → 调用 ComfyUI → 构造代理图片 URL → 返回结果"""
    parsed = parse_user_command(command)
    if parsed["error"]:
        return {"status": "error", "message": parsed["error"]}

    try:
        # ── 1. 加载工作流 ──────────────────────────────────────────────────────
        if parsed["type"] == "text2img":
            workflow = load_workflow("z_image")
            workflow = replace_z_image_model(
                workflow, parsed["base_model_id"], parsed["turbo_model_id"]
            )
        elif parsed["type"] == "img2img":
            workflow = load_workflow("qwen_edit")
        else:
            return {"status": "error", "message": "不支持的指令类型"}

        # ── 2. 替换提示词（含负面提示词）/ 种子 / 分辨率 ──────────────────────
        # 将前端传入的 negative_prompt 透传进去
        workflow = replace_prompt(workflow, parsed["prompt"], negative_prompt)
        workflow, final_seed = replace_seed(
            workflow, parsed["seed_mode"], parsed["seed_value"], user_id
        )
        if parsed["type"] == "text2img":
            workflow = replace_resolution(workflow, parsed["width"], parsed["height"])

        # ── 3. 图生图：上传参考图并注入 LoadImage 节点 ─────────────────────────
        if parsed["type"] == "img2img":
            # 调试用：确认类型
            print(f"[DEBUG] image_bytes type={type(image_bytes)}, len={len(image_bytes) if image_bytes else 0}")

            if not image_bytes:
                return {"status": "error", "message": "图生图模式必须上传图片"}
            uploaded_name = upload_image_to_comfyui(image_bytes, image_filename, image_mimetype, task_type=parsed["type"])
            print(f"[DEBUG] 图片上传成功，云端文件名：{uploaded_name}")
            for node_id, node in workflow["prompt"].items():
                if node.get("class_type") == "LoadImage":
                    workflow["prompt"][node_id]["inputs"]["image"] = uploaded_name
    

        print(f"[DEBUG] 开始提交工作流，task_type={parsed['type']}")
        # ── 4. 提交工作流，等待生图完成 ────────────────────────────────────────
        img_info  = await run_comfyui_workflow(workflow, task_type=parsed["type"])
        print(f"[DEBUG] img_info={img_info}")
        img_name  = img_info["filename"]
        subfolder = img_info["subfolder"]
        jupyter_url   = Config.get_jupyter_url(parsed["type"])

        # ── 5. 构造云端文件 URL ────────────────────────────────────────────────
        xsrf_token = Config.IMG2IMG_XSRF_TOKEN if parsed["type"] == "img2img" else Config.TEXT2IMG_XSRF_TOKEN
        base_cloud_url = f"{jupyter_url.rstrip('/')}/jupyter/files/{Config.COMFYUI_OUTPUT_DIR}"
        if subfolder:
            target_url = f"{base_cloud_url}/{subfolder}/{img_name}?_xsrf={xsrf_token}"
        else:
            target_url = f"{base_cloud_url}/{img_name}?_xsrf={xsrf_token}"

        # ── 6. 代理 URL（前端展示用） ───────────────────────────────────────────
        preview_url = f"/proxy-image?url={quote(target_url)}"

        # ── 7. 构造返回消息 ────────────────────────────────────────────────────
        seed_tips = f"种子：{final_seed}（模式：{parsed['seed_mode']}）"
        if parsed["type"] == "text2img":
            base_name  = Config.Z_IMAGE_BASE_MODELS[parsed["base_model_id"]].split("/")[-1]
            turbo_name = Config.Z_IMAGE_TURBO_MODELS[parsed["turbo_model_id"]].split("/")[-1]
            seed_tips += f"\n生成模型：base={base_name} | turbo={turbo_name}"

        return {
            "status":      "success",
            "message":     f"✅ 生成成功！",
            "preview_url": preview_url,
            "seed":        final_seed,
            "seed_mode":   parsed["seed_mode"],
        }

    except TimeoutError as e:
        return {"status": "error", "message": str(e)}
    except Exception as e:
        return {"status": "error", "message": f"❌ 生成失败：{str(e)}"}

# =============================================================================
# 5. FastAPI 路由
# =============================================================================

app = FastAPI(title="ComfyUI Agent", version="2.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/")
async def generate(
    request:         Request,
    command:         str                   = Form(...),
    negative_prompt: str                   = Form(""),
    image_file:      Optional[UploadFile]  = File(None),
):
    print(f"[DEBUG] 收到请求 command={command}, has_image={image_file is not None}")
    """
    主入口：前端 POST 到根路径。
    multipart/form-data 字段：
      - command          : 指令字符串（必填）
      - negative_prompt  : 负面提示词（选填，文生图有效）
      - image_file       : 图生图参考图（选填）
    """
    # 在异步路由内完成所有文件读取，绝不将 UploadFile 对象传出
    image_bytes    = None
    image_filename = "upload.png"
    image_mimetype = "image/png"

    if image_file is not None:
        try:
            image_bytes = await image_file.read()   # 唯一的 await 读取点
        except Exception as e:
            return {"status": "error", "message": f"文件读取失败：{str(e)}"}
        finally:
            await image_file.close()                # 读取后立即关闭

        image_filename = image_file.filename or "upload.png"
        image_mimetype = image_file.content_type or "image/png"

        # 防御性检查：确认读取到的是 bytes 而非协程
        if not isinstance(image_bytes, bytes):
            return {"status": "error", "message": "文件读取异常，请重新上传"}

        if len(image_bytes) == 0:
            return {"status": "error", "message": "上传的图片文件为空"}

    # 此处 image_bytes 必定是 bytes 或 None，安全传入同步函数
    result = await agent_handle(
        command,
        negative_prompt,
        image_bytes,
        image_filename,
        image_mimetype,
        user_id = request.client.host,
    )
    print(f"[DEBUG] agent_handle 返回：{result}")
    return result

@app.get("/workflow/negative-prompt")
async def get_negative_prompt():
    """
    读取接口：前端初始化时调用，从工作流 JSON 中读取当前负面提示词，显示在页面上。
    """
    try:
        # 加锁，避免读到写了一半的文件
        async with _workflow_lock:
            workflow = load_workflow("z_image")
            nodes = workflow["prompt"]
            for node_id, node in nodes.items():
                if (
                    node.get("class_type") == "CLIPTextEncode"
                    and node.get("_meta", {}).get("title") != "正向"
                ):
                    return {
                        "status":          "success",
                        "negative_prompt": node["inputs"].get("text", ""),
                    }
        return {"status": "success", "negative_prompt": ""}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/workflow/negative-prompt")
async def save_negative_prompt(data: dict):
    """
    保存接口：用户点击"保存"按钮时调用，将负面提示词写回工作流 JSON 文件。
    请求体 JSON：{"negative_prompt": "..."}
    """
    try:
        negative_prompt = data.get("negative_prompt", "").strip()
        # 加锁保护读-改-写原子操作
        async with _workflow_lock:
            workflow = load_workflow("z_image")
            nodes = workflow["prompt"]
            saved = False
            for node_id, node in nodes.items():
                if (
                    node.get("class_type") == "CLIPTextEncode"
                    and node.get("_meta", {}).get("title") != "正向"
                ):
                    nodes[node_id]["inputs"]["text"] = negative_prompt
                    saved = True
            if not saved:
                return {"status": "error", "message": "未找到负向提示词节点"}
            save_workflow("z_image", workflow)
        return {"status": "success", "message": "负面提示词已保存到工作流文件"}
    except Exception as e:
        return {"status": "error", "message": f"保存失败：{str(e)}"}

@app.get("/proxy-image")
async def proxy_image(url: str):
    """
    图片代理路由：后端携带 Cookie 向 AutoDL Jupyter 发起下载，
    将原始图片字节流原封不动（含原始文件名）返回给前端。
    """
    target_url = unquote(url)
    # 根据 URL 判断是文生图还是图生图实例，动态选择 Referer
    if Config.IMG2IMG_JUPYTER_URL.rstrip('/') in target_url:
        cookie  = Config.IMG2IMG_JUPYTER_COOKIE
        referer = Config.IMG2IMG_JUPYTER_URL
    else:
        cookie  = Config.TEXT2IMG_JUPYTER_COOKIE
        referer = Config.TEXT2IMG_JUPYTER_URL
    headers = {
        "Cookie":     cookie,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer":    referer,
    }
    session = get_global_session()  # 必须在 try 外创建
    try:
        resp = session.get(target_url, headers=headers, timeout=30)
        resp.raise_for_status()
        content_type = resp.headers.get("Content-Type", "image/png")
        filename = os.path.basename(urlparse(target_url).path) or "image.png"
        return Response(
            content=resp.content,
            media_type=content_type,
            headers={"Content-Disposition": f'inline; filename="{filename}"'},
        )
    except Exception as e:
        return Response(content=f"图片代理失败：{str(e)}", status_code=500)

@app.post("/power-off")
async def power_off():
    """
    关机路由：前端点击关机按钮时调用。
    调用 AutoDL API 关闭云端实例。
    """
    try:
        results = autodl_remote_power_off(token=AUTODL_TOKEN)
        errors = {k: v for k, v in results.items() if "error" in v or v.get("code") != "Success"}
        if errors:
            return {"status": "error", "message": f"部分实例关机失败：{json.dumps(errors, ensure_ascii=False)}"}
        return {"status": "success", "message": "✅ 两台实例关机指令已发送成功"}
    except Exception as e:
        return {"status": "error", "message": f"关机异常：{str(e)}"}

@app.post("/power-on")
async def power_on():
    """
    开机路由：前端点击开机按钮时调用。
    调用 AutoDL API 开启云端实例。
    """
    try:
        results = autodl_remote_power_on(token=AUTODL_TOKEN)
        errors = {k: v for k, v in results.items() if "error" in v or v.get("code") != "Success"}
        if errors:
            return {"status": "error", "message": f"部分实例开机失败：{json.dumps(errors, ensure_ascii=False)}"}
        return {"status": "success", "message": "✅ 两台实例开机指令已发送成功"}
    except Exception as e:
        return {"status": "error", "message": f"开机异常：{str(e)}"}

@app.get("/health")
async def health_check():
    return {"status": "ok", "message": "ComfyUI Agent 运行正常"}

# =============================================================================
# 6. 启动入口
# =============================================================================

if __name__ == "__main__":
    uvicorn.run(
        "comfyapi:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
    )