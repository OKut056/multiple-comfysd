const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
// 如果你的 style.css 和 index.html 在同一个根目录下
app.use(express.static('.')); 
app.use(express.urlencoded({ extended: true }));

// 开放上传文件夹
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 存储配置：完全保留原文件名、不修改
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    // 核心：直接用原始文件名
    cb(null, file.originalname);
  }
});

const upload = multer({ storage });

// 内存聊天记录
let messages = [];

// 1. 用户发送文字/图片/视频
app.post('/api/send', upload.single('media'), (req, res) => {
  const { text } = req.body;
  const mediaFile = req.file;

  const msg = {
    role: 'user',
    text: text || '',
    mediaUrl: mediaFile ? `/uploads/${mediaFile.originalname}` : null,
    mediaType: mediaFile
      ? mediaFile.mimetype.startsWith('image') ? 'image' : 'video'
      : null,
    time: new Date()
  };

  messages.push(msg);
  res.json({ success: true, msg });
});

// 2. Agent 推送生成好的【原文件+原名】
app.post('/api/agent-push', upload.single('media'), (req, res) => {
  const { text } = req.body;
  const mediaFile = req.file;

  if (!mediaFile) {
    return res.json({ success: false, msg: '缺少媒体文件' });
  }

  const msg = {
    role: 'agent',
    text: text || '已生成',
    mediaUrl: `/uploads/${mediaFile.originalname}`,
    mediaType: mediaFile.mimetype.startsWith('image') ? 'image' : 'video',
    time: new Date()
  };

  messages.push(msg);
  res.json({ success: true, msg });
});

// 3. 获取对话列表
app.get('/api/messages', (req, res) => {
  res.json(messages);
});

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log('✅ 服务已启动：http://localhost:3000');
});