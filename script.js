// 全局变量
let cameraInterval = null;
let enhancedCameraInterval = null;
let autoPatrolInterval = null;
let patrolStartTime = Date.now();
let totalDetections = 0;
let alertsHandled = 0;
let patrolDistance = 0;
let robotPosition = { x: 50, y: 50 };
let landmarks = [];
let currentDetections = [];
let frameCount = 0;
let lastFrameTime = Date.now();

// ===== ESP32 通信相关变量 =====
let esp32Config = {
    mode: 'http',            // demo | http | websocket
    ip: '192.168.243.155',   // 当前火焰检测 ESP32 的 IP
    httpPort: 80,
    wsPort: 81,
    pollInterval: 1000,      // 1 秒刷新一次
    connected: false
};
let httpPollTimer = null;
let websocketConn = null;

// ===== MaixCam 视频流相关变量 =====
let maixcamConfig = {
    ip: '192.168.243.111',
    port: 8080,
    streamActive: false,
    connected: false
};
let maixcamPollTimer = null;

// ===== 火焰检测固件 JSON 模型输入尺寸 =====
const MAIXCAM_CAM_W = 320;
const MAIXCAM_CAM_H = 240;

// ===== 最近一次 ESP32 火焰数据（用于全页面共享）=====
let lastFireData = {
    active: false,
    score: 0,
    x: 0, y: 0, w: 0, h: 0,
    class_id: 0,
    totalDetect: 0,
    totalAlerts: 0,
    uptime: 0,
    ms_since_last: -1,
    source: ''
};

// 视图切换
function showView(viewName) {
    document.querySelectorAll('.view').forEach(view => {
        view.style.display = 'none';
    });
    document.getElementById(viewName + 'View').style.display = 'block';
}

// 模拟数据生成
function generateSensorData() {
    const baseTemp = 25 + Math.sin(Date.now() / 60000) * 5;
    const baseHumidity = 60 + Math.cos(Date.now() / 45000) * 10;
    
    return {
        temperature: (baseTemp + (Math.random() - 0.5) * 2).toFixed(1),
        humidity: Math.max(20, Math.min(90, baseHumidity + (Math.random() - 0.5) * 5)).toFixed(1),
        air_quality: (45 + Math.random() * 30).toFixed(1),
        wind_speed: (1.5 + Math.random() * 4).toFixed(1)
    };
}

// 模拟检测数据
function generateDetections() {
    const detectionTypes = [
        { class: 'deer', type: 'animal', confidence: 0.68, risk: 'low', color: '#22c55e' },
        { class: 'bird', type: 'animal', confidence: 0.61, risk: 'low', color: '#22c55e' },
        { class: 'person', type: 'person', confidence: 0.91, risk: 'medium', color: '#3b82f6' },
        { class: 'smoke', type: 'smoke', confidence: 0.72, risk: 'high', color: '#6b7280' },
        { class: 'fire', type: 'fire', confidence: 0.85, risk: 'critical', color: '#ef4444' }
    ];

    const detections = [];
    const count = Math.floor(Math.random() * 3);
    
    for (let i = 0; i < count; i++) {
        if (Math.random() < 0.3) {
            const type = detectionTypes[Math.floor(Math.random() * detectionTypes.length)];
            detections.push({
                ...type,
                bbox: [
                    Math.random() * 400 + 50,
                    Math.random() * 300 + 50,
                    Math.random() * 100 + 450,
                    Math.random() * 100 + 350
                ]
            });
        }
    }
    
    return detections;
}

// 更新传感器显示
function updateSensorDisplay() {
    const sensorData = generateSensorData();
    
    document.getElementById('temperature').textContent = sensorData.temperature + '°C';
    document.getElementById('humidity').textContent = sensorData.humidity + '%';
    document.getElementById('windSpeed').textContent = sensorData.wind_speed + ' m/s';
    
    const aq = parseFloat(sensorData.air_quality);
    document.getElementById('airQuality').textContent = aq < 50 ? '优良' : aq < 100 ? '中等' : '较差';
    document.getElementById('airQuality').className = aq < 50 ? 'status-value success' : 
                                                     aq < 100 ? 'status-value warning' : 'status-value critical';
}

// 摄像头功能
function startCamera() {
    if (cameraInterval) clearInterval(cameraInterval);

    const cameraFeed = document.getElementById('cameraFeed');
    // 不再重写整个 cameraFeed.innerHTML，保留 <img id="maixcamStream"> / #cameraPlaceholder / #streamInfo
    let overlay = document.getElementById('cameraOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'camera-overlay';
        overlay.id = 'cameraOverlay';
        cameraFeed.insertBefore(overlay, cameraFeed.firstChild);
    } else {
        overlay.innerHTML = '';
    }
    // 只有 MaixCam 视频没激活时才显示"巡逻中…"占位提示文字
    let hint = cameraFeed.querySelector('.camera-demo-hint');
    if (!maixcamConfig.streamActive) {
        if (!hint) {
            hint = document.createElement('div');
            hint.className = 'camera-demo-hint';
            hint.style.color = '#22c55e';
            hint.style.fontSize = '18px';
            cameraFeed.appendChild(hint);
        }
        hint.textContent = '🌲 森林巡逻进行中...';
    } else if (hint) {
        hint.remove();
    }

    cameraInterval = setInterval(() => {
        updateCameraOverlay('cameraOverlay');
    }, 1000);

    addLog('巡逻相机已启动', 'success');
}

function stopCamera() {
    if (cameraInterval) {
        clearInterval(cameraInterval);
        cameraInterval = null;
    }
    // 只清 overlay 内容 + 显示"停止"提示，不破坏 MaixCam 视频/占位/信息条 DOM
    const cameraFeed = document.getElementById('cameraFeed');
    const overlay = document.getElementById('cameraOverlay');
    if (overlay) overlay.innerHTML = '';
    let hint = cameraFeed.querySelector('.camera-demo-hint');
    if (!hint) {
        hint = document.createElement('div');
        hint.className = 'camera-demo-hint';
        hint.style.color = '#f59e0b';
        hint.style.fontSize = '18px';
        cameraFeed.appendChild(hint);
    }
    hint.textContent = '⏹ 巡逻监控已停止';
    addLog('巡逻监控已停止', 'warning');
}

function updateCameraOverlay(overlayId) {
    const overlay = document.getElementById(overlayId);
    const detections = generateDetections();
    
    overlay.innerHTML = '';
    detections.forEach((detection, index) => {
        const [x1, y1, x2, y2] = detection.bbox;
        
        // 检测框
        const box = document.createElement('div');
        box.className = 'detection-box';
        box.style.left = x1 + 'px';
        box.style.top = y1 + 'px';
        box.style.width = (x2 - x1) + 'px';
        box.style.height = (y2 - y1) + 'px';
        box.style.borderColor = detection.color;
        
        // 标签
        const label = document.createElement('div');
        label.className = 'detection-label';
        label.style.left = x1 + 'px';
        label.style.top = y1 + 'px';
        label.textContent = `${detection.class} ${(detection.confidence * 100).toFixed(1)}%`;
        label.style.background = detection.color;
        
        overlay.appendChild(box);
        overlay.appendChild(label);
    });
}

// 增强摄像头功能
function startEnhancedCamera() {
    if (enhancedCameraInterval) clearInterval(enhancedCameraInterval);
    
    enhancedCameraInterval = setInterval(() => {
        frameCount++;
        const now = Date.now();
        const fps = Math.round(frameCount / ((now - lastFrameTime) / 1000));
        document.getElementById('frameRate').textContent = fps;
        
        const detections = generateDetections();
        currentDetections = detections;
        updateCameraOverlay('enhancedOverlay');
        updateObjectList(detections);
        updateDetectionStats(detections);
    }, 500);
    
    addLog('增强检测模式已启动', 'success');
}

function stopEnhancedCamera() {
    if (enhancedCameraInterval) {
        clearInterval(enhancedCameraInterval);
        enhancedCameraInterval = null;
    }
    document.getElementById('enhancedOverlay').innerHTML = '';
    document.getElementById('objectList').innerHTML = 
        '<div style="text-align:center;color:#666;padding:40px;">检测已停止</div>';
    addLog('增强检测已停止', 'warning');
}

function updateObjectList(detections) {
    const objectList = document.getElementById('objectList');
    objectList.innerHTML = '';
    
    if (detections.length === 0) {
        objectList.innerHTML = '<div style="text-align:center;color:#666;padding:20px;">未检测到目标</div>';
        return;
    }
    
    detections.forEach(detection => {
        const item = document.createElement('div');
        item.className = `object-item ${detection.type}`;
        item.style.cssText = 'background: rgba(255,255,255,0.05); padding:15px; margin-bottom:10px; border-radius:8px; border-left:4px solid ' + detection.color;
        
        const confidencePercent = (detection.confidence * 100).toFixed(1);
        
        item.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <strong>${detection.class}</strong>
                <span style="color: #22c55e; font-weight: bold;">${confidencePercent}%</span>
            </div>
            <div style="height:6px; background:rgba(255,255,255,0.2); border-radius:3px; margin:5px 0; overflow:hidden;">
                <div style="height:100%; background:#22c55e; border-radius:3px; width: ${confidencePercent}%"></div>
            </div>
            <div style="font-size: 0.8em; color: #a0aec0;">
                类型: ${detection.type} | 风险: ${detection.risk}
            </div>
        `;
        
        objectList.appendChild(item);
    });
}

function updateDetectionStats(detections) {
    document.getElementById('totalObjects').textContent = detections.length;
    
    const highRiskCount = detections.filter(d => 
        d.risk === 'high' || d.risk === 'critical'
    ).length;
    document.getElementById('highRiskCount').textContent = highRiskCount;
    
    const avgConfidence = detections.length > 0 ? 
        detections.reduce((sum, d) => sum + d.confidence, 0) / detections.length : 0;
    document.getElementById('avgConfidence').textContent = (avgConfidence * 100).toFixed(1) + '%';
}

// 机器人控制功能
function moveRobot(direction) {
    const step = 2;
    switch(direction) {
        case 'forward':
            robotPosition.y = Math.max(5, robotPosition.y - step);
            break;
        case 'backward':
            robotPosition.y = Math.min(95, robotPosition.y + step);
            break;
        case 'left':
            robotPosition.x = Math.max(5, robotPosition.x - step);
            break;
        case 'right':
            robotPosition.x = Math.min(95, robotPosition.x + step);
            break;
    }
    patrolDistance += 0.1;
    updateMap();
    addLog(`机器人向${getDirectionText(direction)}移动`, 'info');
}

function getDirectionText(direction) {
    const map = {
        'forward': '前',
        'backward': '后', 
        'left': '左',
        'right': '右'
    };
    return map[direction] || direction;
}

function stopRobot() {
    if (autoPatrolInterval) {
        clearInterval(autoPatrolInterval);
    }
    addLog('紧急停止已激活', 'warning');
}

function startPatrol() {
    addLog('开始自动巡逻模式', 'success');
    if (autoPatrolInterval) clearInterval(autoPatrolInterval);
    
    autoPatrolInterval = setInterval(() => {
        if (Math.random() < 0.3) {
            const directions = ['forward', 'backward', 'left', 'right'];
            moveRobot(directions[Math.floor(Math.random() * directions.length)]);
        }
    }, 2000);
}

function pausePatrol() {
    if (autoPatrolInterval) {
        clearInterval(autoPatrolInterval);
        addLog('自动巡逻已暂停', 'warning');
    }
}

function returnToBase() {
    robotPosition = { x: 50, y: 50 };
    updateMap();
    addLog('返回基地命令已执行', 'success');
}

function updateMap() {
    const robotMarker = document.getElementById('robotMarker');
    if (!robotMarker) return;
    robotMarker.style.left = robotPosition.x + '%';
    robotMarker.style.top = robotPosition.y + '%';
    
    // 随机生成地标
    if (Math.random() < 0.2 && landmarks.length < 20) {
        const map = document.getElementById('slamMap');
        if (!map) return;
        const landmark = document.createElement('div');
        landmark.className = Math.random() < 0.1 ? 'landmark alert-landmark' : 'landmark';
        landmark.style.left = Math.random() * 90 + 5 + '%';
        landmark.style.top = Math.random() * 90 + 5 + '%';
        map.appendChild(landmark);
        landmarks.push(landmark);
    }
    
    // 更新位置信息
    const posX = document.getElementById('posX');
    const posY = document.getElementById('posY');
    const patrolProgress = document.getElementById('patrolProgress');
    if (posX) posX.textContent = ((robotPosition.x - 50) * 2).toFixed(1) + ' m';
    if (posY) posY.textContent = ((robotPosition.y - 50) * 2).toFixed(1) + ' m';
    if (patrolProgress) patrolProgress.textContent = Math.round((patrolDistance / 10) * 100) + '%';
}

// 系统功能
function testAlert(alertType) {
    const alertMap = {
        'fire': { level: 'critical', message: '检测到火源！需要立即处理', color: '#ef4444' },
        'smoke': { level: 'high', message: '检测到烟雾，可能存在火灾风险', color: '#f59e0b' },
        'animal': { level: 'low', message: '检测到野生动物活动', color: '#22c55e' },
        'person': { level: 'medium', message: '检测到人员活动', color: '#3b82f6' }
    };
    
    const alert = alertMap[alertType];
    if (alert) {
        addLog(`${alertType}警报测试: 已触发`, 'success');
        
        const resultsDiv = document.getElementById('detectionResults');
        const alertDiv = document.createElement('div');
        alertDiv.className = `alert-item ${alert.level}`;
        alertDiv.innerHTML = `
            <strong>${alertType.toUpperCase()} 警报</strong><br>
            ${alert.message}<br>
            <small>时间: ${new Date().toLocaleTimeString()}</small>
        `;
        resultsDiv.appendChild(alertDiv);
        
        // 更新风险等级
        updateRiskIndicator(alert.level);
    }
}

function updateRiskIndicator(riskLevel) {
    const riskElement = document.getElementById('riskLevel');
    if (!riskElement) return;
    riskElement.innerHTML = `<span class="risk-indicator risk-${riskLevel}"></span>${getRiskText(riskLevel)}`;
}

function getRiskText(riskLevel) {
    const riskMap = {
        'low': '低风险',
        'medium': '中等风险', 
        'high': '高风险',
        'critical': '严重风险'
    };
    return riskMap[riskLevel] || '未知风险';
}

function clearAlerts() {
    document.getElementById('detectionResults').innerHTML = 
        '<div style="text-align:center;color:#666;padding:20px;">无活跃警报</div>';
    updateRiskIndicator('low');
    addLog('所有警报已清除', 'info');
}

function testDetection() {
    const detections = generateDetections();
    totalDetections += detections.length;
    
    addLog(`目标检测完成: 发现 ${detections.length} 个目标`, 'success');
    
    const resultsDiv = document.getElementById('detectionResults');
    resultsDiv.innerHTML = '';
    
    if (detections.length > 0) {
        detections.forEach(detection => {
            const detDiv = document.createElement('div');
            detDiv.className = 'alert-item info';
            detDiv.innerHTML = `
                <strong>${detection.class}</strong><br>
                类型: ${detection.type}<br>
                置信度: ${(detection.confidence * 100).toFixed(1)}%<br>
                风险等级: ${detection.risk}
            `;
            resultsDiv.appendChild(detDiv);
        });
    } else {
        resultsDiv.innerHTML = '<div style="text-align:center;color:#666;padding:20px;">未检测到目标</div>';
    }
}

function runDiagnostics() {
    addLog('开始系统全面诊断...', 'info');
    
    setTimeout(() => {
        document.getElementById('slamDiag').textContent = '正常';
        document.getElementById('visionDiag').textContent = '正常';
        document.getElementById('commDiag').textContent = '正常';
        document.getElementById('powerDiag').textContent = '正常';
        addLog('系统诊断完成: 所有系统正常', 'success');
    }, 2000);
}

function addTask() {
    const tasks = [
        '高优先级区域检查',
        '传感器校准',
        '数据备份',
        '系统软件更新',
        '电池更换提醒'
    ];
    const randomTask = tasks[Math.floor(Math.random() * tasks.length)];
    
    const taskQueue = document.getElementById('taskQueue');
    const taskCount = taskQueue.children.length + 1;
    const taskItem = document.createElement('div');
    taskItem.className = 'task-item';
    taskItem.textContent = `${taskCount}. ${randomTask}`;
    taskQueue.appendChild(taskItem);
    
    addLog(`新任务已添加: ${randomTask}`, 'info');
}

function captureSnapshot() {
    addLog('快照已保存', 'success');
}

// 指标更新
function updateMetrics() {
    const uptime = Math.floor((Date.now() - patrolStartTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeEl = document.getElementById('uptime');
    if (uptimeEl) uptimeEl.textContent = `${hours}:${minutes.toString().padStart(2, '0')}`;
    
    const totalDetectionsEl = document.getElementById('totalDetections');
    if (totalDetectionsEl) totalDetectionsEl.textContent = totalDetections;
    
    const alertsHandledEl = document.getElementById('alertsHandled');
    if (alertsHandledEl) alertsHandledEl.textContent = alertsHandled;
    
    const patrolDistanceEl = document.getElementById('patrolDistance');
    if (patrolDistanceEl) patrolDistanceEl.textContent = patrolDistance.toFixed(1);
    
    const battery = Math.max(10, 85 - (uptime / 3600) * 5);
    const batteryLevelEl = document.getElementById('batteryLevel');
    if (batteryLevelEl) batteryLevelEl.textContent = Math.round(battery) + '%';
    
    const dataUsage = 1.2 + (uptime / 3600) * 0.1;
    const dataUsageEl = document.getElementById('dataUsage');
    if (dataUsageEl) dataUsageEl.textContent = dataUsage.toFixed(1);
}

function addLog(message, type = 'info') {
    const logContainer = document.getElementById('systemLog');
    if (!logContainer) return;
    
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    
    const timestamp = new Date().toLocaleTimeString();
    const color = type === 'error' ? '#ef4444' : 
                 type === 'success' ? '#22c55e' : 
                 type === 'warning' ? '#f59e0b' : '#3b82f6';
    
    logEntry.innerHTML = `<span style="color: ${color}">[${timestamp}] ${message}</span>`;
    logContainer.appendChild(logEntry);
    logContainer.scrollTop = logContainer.scrollHeight;
    
    const entries = logContainer.querySelectorAll('.log-entry');
    if (entries.length > 50) {
        entries[0].remove();
    }
}

// 初始化系统
function initializeSystem() {
    addLog('森林巡逻机器人系统初始化中...', 'info');
    addLog('演示模式已激活 - 使用模拟数据', 'info');
    
    // 启动定期更新
    setInterval(updateSensorDisplay, 3000);
    setInterval(updateMetrics, 1000);
    setInterval(updateMap, 5000);
    
    // 模拟随机事件
    setInterval(() => {
        if (Math.random() < 0.1) {
            totalDetections++;
            addLog(`检测到森林目标 (#${totalDetections})`, 'success');
        }
    }, 8000);
    
    setInterval(() => {
        if (Math.random() < 0.05) {
            alertsHandled++;
            addLog(`警报已处理 (#${alertsHandled})`, 'warning');
        }
    }, 15000);
    
    // 初始地图
    updateMap();
    
    addLog('系统初始化完成，开始森林巡逻演示', 'success');
    startCamera();
}

// 启动系统
document.addEventListener('DOMContentLoaded', initializeSystem);

// ========================================================================
//                        ESP32 设备连接逻辑
// ========================================================================

// 切换 ESP32 配置面板显示
function toggleEsp32Panel() {
    const panel = document.getElementById('esp32ConfigPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

// 更新连接模式的显示状态
function updateConnMode() {
    const mode = document.getElementById('connMode').value;
    esp32Config.mode = mode;
    esp32Log(`连接模式已切换为: ${mode === 'demo' ? '演示模式' : mode === 'http' ? 'HTTP轮询' : 'WebSocket实时'}`, 'info');
}

// 连接 ESP32 设备
function connectEsp32() {
    esp32Config.ip = document.getElementById('esp32Ip').value.trim();
    esp32Config.httpPort = parseInt(document.getElementById('httpPort').value) || 80;
    esp32Config.wsPort = parseInt(document.getElementById('wsPort').value) || 81;
    esp32Config.pollInterval = parseInt(document.getElementById('pollInterval').value) || 2000;
    esp32Config.mode = document.getElementById('connMode').value;

    if (esp32Config.mode === 'demo') {
        disconnectEsp32();
        esp32Log('已切换到演示模式（使用模拟数据）', 'warning');
        return;
    }

    if (!esp32Config.ip) {
        esp32Log('错误: 请填写ESP32的IP地址', 'error');
        return;
    }

    setConnStatus('connecting');
    esp32Log(`正在连接 ESP32 (${esp32Config.ip})...`, 'info');

    if (esp32Config.mode === 'http') {
        startHttpPolling();
    } else if (esp32Config.mode === 'websocket') {
        startWebSocket();
    }
}

// 断开连接
function disconnectEsp32() {
    // 停止HTTP轮询
    if (httpPollTimer) {
        clearInterval(httpPollTimer);
        httpPollTimer = null;
    }
    // 关闭WebSocket
    if (websocketConn) {
        try { websocketConn.close(); } catch(e) {}
        websocketConn = null;
    }
    esp32Config.connected = false;
    setConnStatus('disconnected');
    esp32Log('已断开ESP32连接，切换到模拟数据模式', 'warning');
}

// 测试连接
async function testConnection() {
    const ip = document.getElementById('esp32Ip').value.trim();
    const port = parseInt(document.getElementById('httpPort').value) || 80;
    if (!ip) {
        esp32Log('错误: 请先填写ESP32的IP地址', 'error');
        return;
    }

    esp32Log(`正在测试连接 http://${ip}:${port}/api/status ...`, 'info');
    try {
        const t0 = performance.now();
        const resp = await fetch(`http://${ip}:${port}/api/status`, {
            mode: 'cors',
            signal: AbortSignal.timeout(5000)
        });
        const dt = (performance.now() - t0).toFixed(0);
        if (resp.ok) {
            const data = await resp.json();
            esp32Log(`✅ 连接成功! 延迟: ${dt}ms | 温度: ${data.sensors?.temperature ?? '?'}°C | 电池: ${data.sensors?.battery ?? '?'}%`, 'success');
        } else {
            esp32Log(`❌ HTTP错误: ${resp.status} ${resp.statusText}`, 'error');
        }
    } catch(err) {
        esp32Log(`❌ 连接失败: ${err.message}`, 'error');
        esp32Log('提示: 请确认ESP32已连接同一WiFi，且已刷入固件并启动CORS。也可能是浏览器混合内容限制（HTTPS页面禁止访问HTTP设备），请在本地用http://localhost打开本页面。', 'warning');
    }
}

// ============ HTTP 轮询模式 ============
function startHttpPolling() {
    const url = `http://${esp32Config.ip}:${esp32Config.httpPort}/api/status`;
    esp32Log(`📡 开始 HTTP 轮询 → ${url} (间隔 ${esp32Config.pollInterval}ms，超时 5s)`, 'info');

    // 先立即请求一次（不 await，允许异步返回后再注册定时器）
    httpFetchOnce();

    if (httpPollTimer) {
        clearInterval(httpPollTimer);
        httpPollTimer = null;
    }
    httpPollTimer = setInterval(httpFetchOnce, esp32Config.pollInterval);
    esp32Log('⏳ 第一次请求中...（如失败会在下方显示详细原因）', 'info');
}

async function httpFetchOnce() {
    const url = `http://${esp32Config.ip}:${esp32Config.httpPort}/api/status`;
    // 容错：连续失败计数器（偶发超时/丢包不立即断开）
    if (typeof httpFetchOnce._failStreak !== 'number') httpFetchOnce._failStreak = 0;
    const MAX_FAILS = 3;  // 连续失败3次才真正判定为断开
    try {
        // 超时设为 8s（ESP32 是嵌入式设备，处理串口+检测时偶尔会有延迟）
        const resp = await fetch(
            url,
            { mode: 'cors', signal: AbortSignal.timeout(8000) }
        );
        if (resp.ok) {
            let data;
            try {
                data = await resp.json();
            } catch (jsonErr) {
                const bodyPreview = await resp.text().catch(() => '(无法读取响应体)');
                throw new Error(`JSON 解析失败: ${jsonErr.message} | 响应前100字符: ${String(bodyPreview).slice(0,100)}`);
            }
            try {
                applyEsp32Data(data);
            } catch (applyErr) {
                esp32Log(`⚠️ 数据应用失败: ${applyErr.message}`, 'warning');
                console.error('applyEsp32Data error:', applyErr);
            }
            if (!esp32Config.connected) {
                esp32Config.connected = true;
                setConnStatus('connected');
                esp32Log(`✅ HTTP连接成功：${url}，开始接收数据`, 'success');
                if (!maixcamConfig.streamActive) {
                    setTimeout(() => startMaixcamStream(), 300);
                }
            }
            httpFetchOnce._failStreak = 0;
            httpFetchOnce._lastErr = '';
        } else {
            httpFetchOnce._failStreak++;
            let bodyHint = '';
            try {
                const t = await resp.text();
                if (t) bodyHint = ` | 响应: ${String(t).slice(0,80)}`;
            } catch(_) {}
            const msg = `❌ HTTP 错误 ${resp.status} ${resp.statusText || ''}${bodyHint}`;
            // 连续失败达到阈值才真正标记断开
            if (httpFetchOnce._failStreak >= MAX_FAILS) {
                const wasConnected = esp32Config.connected;
                esp32Config.connected = false;
                setConnStatus('disconnected');
                if (!wasConnected || msg !== (httpFetchOnce._lastErr || '')) {
                    esp32Log(msg, 'error');
                    esp32Log('建议：先用「🔍 测试连接」按钮单独排查是否网络可达', 'warning');
                    httpFetchOnce._lastErr = msg;
                }
            } else {
                // 偶发失败只在控制台提示，不刷红色错误
                console.warn(`HTTP 失败 ${httpFetchOnce._failStreak}/${MAX_FAILS}: ${msg}`);
            }
        }
    } catch(err) {
        httpFetchOnce._failStreak++;
        const isTimeout = /timeout|timed out/i.test(err.message);
        if (httpFetchOnce._failStreak >= MAX_FAILS) {
            const wasConnected = esp32Config.connected;
            esp32Config.connected = false;
            setConnStatus('disconnected');
            const msg = wasConnected
                ? `⚠️ HTTP连接中断（连续${httpFetchOnce._failStreak}次失败）: ${err.message}`
                : `❌ 无法连接 ESP32: ${err.message}`;
            if (msg !== (httpFetchOnce._lastErr || '')) {
                esp32Log(msg, 'error');
                if (!wasConnected) {
                    esp32Log('排查：①确认 ESP32 WiFi 指示灯正常  ②先用「🔍 测试连接」单独验证  ③浏览器和 ESP32 是否同一 WiFi  ④用 http://localhost 打开页面', 'warning');
                    esp32Log('补充：按 Ctrl+Shift+R 强制刷新浏览器缓存', 'warning');
                }
                httpFetchOnce._lastErr = msg;
            }
        } else {
            // 偶发超时/失败，只打 console，不弹红色错误（避免用户焦虑）
            console.warn(`HTTP 偶发失败 ${httpFetchOnce._failStreak}/${MAX_FAILS}: ${err.message}`);
        }
    }
}

// HTTP 发送控制命令
async function httpSendAction(action, params = {}) {
    if (esp32Config.mode !== 'http' || !esp32Config.connected) return false;
    try {
        const resp = await fetch(
            `http://${esp32Config.ip}:${esp32Config.httpPort}/api/control`,
            {
                method: 'POST',
                mode: 'cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, ...params }),
                signal: AbortSignal.timeout(3000)
            }
        );
        return resp.ok;
    } catch(err) {
        esp32Log('命令发送失败: ' + err.message, 'error');
        return false;
    }
}

// ============ WebSocket 实时模式 ============
function startWebSocket() {
    const wsUrl = `ws://${esp32Config.ip}:${esp32Config.wsPort}/`;
    esp32Log(`正在连接 WebSocket: ${wsUrl}`, 'info');

    try {
        websocketConn = new WebSocket(wsUrl);

        websocketConn.onopen = () => {
            esp32Config.connected = true;
            setConnStatus('connected');
            esp32Log('✅ WebSocket 已连接，实时数据同步中', 'success');
            // 首次连接成功后，自动尝试拉起 MaixCam 实时视频
            if (!maixcamConfig.streamActive) {
                setTimeout(() => startMaixcamStream(), 300);
            }
            // 发个心跳测试
            wsSend({ action: 'ping' });
        };

        websocketConn.onmessage = (evt) => {
            try {
                const data = JSON.parse(evt.data);
                // 处理心跳响应
                if (data.type === 'pong') return;
                // 处理警报推送
                if (data.type === 'alert' && data.data) {
                    esp32Log(`⚠️ 警报推送: ${data.data.message}`, 'warning');
                    return;
                }
                // 普通状态数据
                applyEsp32Data(data);
            } catch(err) {
                console.error('WS数据解析错误:', err);
            }
        };

        websocketConn.onerror = (err) => {
            esp32Log('❌ WebSocket 错误: ' + (err.message || '连接失败'), 'error');
        };

        websocketConn.onclose = () => {
            esp32Config.connected = false;
            setConnStatus('disconnected');
            esp32Log('WebSocket 已断开', 'warning');
            websocketConn = null;
        };
    } catch(err) {
        esp32Log('WebSocket 创建失败: ' + err.message, 'error');
    }
}

function wsSend(obj) {
    if (websocketConn && websocketConn.readyState === WebSocket.OPEN) {
        websocketConn.send(JSON.stringify(obj));
        return true;
    }
    return false;
}

// ============ 数据同步（核心函数） ============
// 将 ESP32 传过来的数据应用到页面
function applyEsp32Data(data) {
    try {
        // ============================================
        // 🔥 优先解析火焰检测固件 JSON：
        // {active, x, y, w, h, class_id, score,
        //  totalDetect, totalAlerts, uptime,
        //  ms_since_last, wifi_connected, ip, source, timestamp}
        // ============================================
        if (data.active !== undefined || data.totalDetect !== undefined) {
            lastFireData = {
                active:       !!data.active,
                score:        parseFloat(data.score) || 0,
                x:            parseInt(data.x) || 0,
                y:            parseInt(data.y) || 0,
                w:            parseInt(data.w) || 0,
                h:            parseInt(data.h) || 0,
                class_id:     parseInt(data.class_id) || 0,
                totalDetect:  parseInt(data.totalDetect) || 0,
                totalAlerts:  parseInt(data.totalAlerts) || 0,
                uptime:       parseInt(data.uptime) || 0,
                ms_since_last: data.ms_since_last !== undefined ? parseInt(data.ms_since_last) : -1,
                source:       data.source || ''
            };

            // ---------- 1. 全局顶栏 + 火焰状态徽标 ----------
            applyFireHeaderStatus(lastFireData);

            // ---------- 2. 主控制台：机器人状态 ----------
            const sysEl = document.getElementById('systemStatus');
            if (sysEl) {
                if (lastFireData.active) {
                    sysEl.textContent = '🔥 火焰警报';
                    sysEl.className = 'status-value critical';
                } else {
                    sysEl.textContent = '运行中';
                    sysEl.className = 'status-value success';
                }
            }

            // 风险等级
            if (lastFireData.active) {
                updateRiskIndicator('critical');
            } else if (lastFireData.totalAlerts > 0) {
                updateRiskIndicator('medium');
            } else {
                updateRiskIndicator('low');
            }

            // 目标检测状态
            const detEl = document.getElementById('detectionStatus');
            if (detEl) {
                detEl.textContent = lastFireData.source ? `活跃 (${lastFireData.source})` : '活跃';
                detEl.className = 'status-value success';
            }

            // ---------- 3. 主控制台：环境传感器填占位 ----------
            const tempEl = document.getElementById('temperature');
            if (tempEl && !data.sensors?.temperature) {
                // 没有温度传感器，把温度卡片显示成「在线」
                tempEl.textContent = data.wifi_connected ? '在线' : '离线';
            }
            const aqEl = document.getElementById('airQuality');
            if (aqEl) {
                aqEl.textContent = lastFireData.active ? '火警' : '正常';
                aqEl.className = lastFireData.active ? 'status-value critical' : 'status-value success';
            }
            const windEl = document.getElementById('windSpeed');
            if (windEl) {
                const m = Math.floor(lastFireData.uptime / 60);
                const s = lastFireData.uptime % 60;
                windEl.textContent = `${m}:${String(s).padStart(2,'0')}`;
                windEl.previousElementSibling.textContent = '运行时长:';
            }

            // ---------- 4. 位置信息：用 x/y 画火焰坐标 ----------
            const pxEl = document.getElementById('posX');
            if (pxEl) { pxEl.textContent = `(${lastFireData.x}, ${lastFireData.y})`; pxEl.previousElementSibling.textContent = '火焰坐标:'; }
            const pyEl = document.getElementById('posY');
            if (pyEl) {
                if (lastFireData.w > 0 && lastFireData.h > 0) {
                    pyEl.textContent = `${lastFireData.w}×${lastFireData.h}`;
                } else {
                    pyEl.textContent = '-';
                }
                pyEl.previousElementSibling.textContent = '火焰尺寸:';
            }
            const progEl = document.getElementById('patrolProgress');
            if (progEl) { progEl.textContent = '火焰巡检'; progEl.previousElementSibling.textContent = '当前任务:'; }
            const mapQEl = document.getElementById('mapQuality');
            if (mapQEl) { mapQEl.textContent = lastFireData.totalDetect; mapQEl.previousElementSibling.textContent = '累计检测:'; }

            // 地图上的机器人标记改成火焰指示
            const marker = document.getElementById('robotMarker');
            if (marker) {
                // 用 320x240 映射到百分比
                const nx = 5 + (lastFireData.x / MAIXCAM_CAM_W) * 90;
                const ny = 5 + (lastFireData.y / MAIXCAM_CAM_H) * 90;
                marker.style.left = nx + '%';
                marker.style.top  = ny + '%';
                if (lastFireData.active) {
                    marker.style.background = '#ef4444';
                    marker.style.boxShadow = '0 0 12px #ef4444';
                } else {
                    marker.style.background = '#22c55e';
                    marker.style.boxShadow = 'none';
                }
            }

            // ---------- 5. 增强控制面板：指标卡 ----------
            const distEl = document.getElementById('patrolDistance');
            if (distEl) distEl.textContent = (lastFireData.totalDetect / 10).toFixed(1);
            const totEl = document.getElementById('totalDetections');
            if (totEl) totEl.textContent = lastFireData.totalDetect;
            const altEl = document.getElementById('alertsHandled');
            if (altEl) altEl.textContent = lastFireData.totalAlerts;
            const upEl  = document.getElementById('uptime');
            if (upEl) {
                const mm = Math.floor(lastFireData.uptime / 60);
                const hh = Math.floor(mm / 60);
                const rr = mm % 60;
                upEl.textContent = `${hh}:${String(rr).padStart(2,'0')}`;
            }
            const batEl = document.getElementById('batteryLevel');
            if (batEl) {
                batEl.textContent = data.wifi_connected ? 'WiFi已连' : 'WiFi断开';
            }

            // ---------- 6. 警报：检测结果列表 ----------
            updateFireDetectionResults(lastFireData);

            // ---------- 7. 把真实火焰坐标推到两处画面 ----------
            renderFireBoxesOnOverlays(lastFireData);

            // ---------- 8. 用真实火焰数据刷新增强检测视图 ----------
            updateFireViewStats(lastFireData);
        }

        // ============================================
        // 兼容旧的 sensors/robot/alert 结构（将来加传感器时用）
        // ============================================
        const s = data.sensors || {};
        const r = data.robot   || {};
        const a = data.alert;

        if (s.temperature != null)
            document.getElementById('temperature').textContent = s.temperature + '°C';
        if (s.humidity != null)
            document.getElementById('humidity').textContent = s.humidity + '%';
        if (s.wind_speed != null)
            document.getElementById('windSpeed').textContent = s.wind_speed + ' m/s';
        if (s.battery != null) {
            const batEl = document.getElementById('batteryLevel');
            if (batEl) batEl.textContent = Math.round(s.battery) + '%';
        }
        if (r.systemStatus)
            document.getElementById('systemStatus').textContent = r.systemStatus;
        if (r.riskLevel)
            updateRiskIndicator(r.riskLevel);

        if (a && a.active !== false) {
            const resultsDiv = document.getElementById('detectionResults');
            if (!resultsDiv.dataset.lastAlert || resultsDiv.dataset.lastAlert !== (a.timestamp + a.message)) {
                resultsDiv.dataset.lastAlert = a.timestamp + a.message;
                const alertDiv = document.createElement('div');
                alertDiv.className = `alert-item ${a.level}`;
                alertDiv.innerHTML = `
                    <strong>${(a.type || '').toUpperCase()} 警报</strong><br>
                    ${a.message || ''}<br>
                    <small>时间: ${a.timestamp || new Date().toLocaleTimeString()}</small>
                `;
                resultsDiv.appendChild(alertDiv);
            }
        }

        // 旧版检测视图兜底（如果将来切回模拟数据）
        if (esp32Config.mode === 'demo') {
            updateDetectionFromEsp32(s);
        }

        if (data.maixcam) {
            applyMaixcamData(data.maixcam);
        }
    } catch(err) {
        console.error('应用ESP32数据时出错:', err);
    }
}

// ====== 顶栏：火焰状态徽标 ======
function applyFireHeaderStatus(d) {
    const statusBtn = document.getElementById('connStatus');
    if (!statusBtn) return;
    const btn = statusBtn.closest('.nav-esp32');

    if (!esp32Config.connected) {
        statusBtn.textContent = '未连接';
        statusBtn.className = 'conn-status';
        if (btn) btn.style.background = '';
        return;
    }

    if (d.active) {
        statusBtn.textContent = '🔥 火警';
        statusBtn.className = 'conn-status fire-alarm';
    } else {
        statusBtn.textContent = '已连接';
        statusBtn.className = 'conn-status esp32-connected';
    }
    if (btn) {
        btn.style.background = d.active ? 'linear-gradient(135deg,#ef4444,#f59e0b)' : '';
    }

    // 实时巡逻图上的徽章
    const badge = document.getElementById('maixcamBadge');
    if (badge) {
        badge.classList.remove('online','offline');
        if (d.active) {
            badge.textContent = '🔥 检测到火焰';
            badge.classList.add('online');
            badge.style.background = '#ef4444';
        } else {
            badge.textContent = d.source ? `在线 · ${d.source}` : 'ESP32 在线';
            badge.classList.add('online');
            badge.style.background = '';
        }
    }

    // 两个摄像头画面：有火警时加红色外框闪烁
    const mainFeed = document.getElementById('cameraFeed');
    if (mainFeed) mainFeed.classList.toggle('fire-alarm', !!d.active);
    const enhFeed = document.getElementById('enhancedCameraFeed');
    if (enhFeed) enhFeed.classList.toggle('fire-alarm', !!d.active);
}

// ====== 实时检测结果列表（主控制台侧边栏）======
function updateFireDetectionResults(d) {
    const div = document.getElementById('detectionResults');
    if (!div) return;

    const sig = `${d.active}-${d.score}-${d.x}-${d.y}-${d.w}-${d.h}-${d.totalDetect}-${d.totalAlerts}`;
    if (div.dataset.fireSig === sig) return;
    div.dataset.fireSig = sig;

    // 活动警报放在顶部
    const lines = [];
    if (d.active) {
        lines.push(`
            <div class="alert-item" style="border-color:#ef4444;border-left:6px solid #ef4444;">
                <strong style="color:#ef4444;">🔥 火焰警报</strong><br>
                置信度 <b>${(d.score*100).toFixed(1)}%</b>
                ｜位置 <b>(${d.x}, ${d.y})</b>
                ｜尺寸 ${d.w}×${d.h}<br>
                <small>类别ID: ${d.class_id} ｜来源: ${d.source || '未知'}</small>
            </div>
        `);
    }
    lines.push(`
        <div class="alert-item info" style="margin-top:8px;">
            📊 统计<br>
            累计检测: <b>${d.totalDetect}</b> 次<br>
            累计报警: <b>${d.totalAlerts}</b> 次<br>
            ${d.ms_since_last >= 0
                ? `距上次事件: <b>${(d.ms_since_last/1000).toFixed(1)}s</b>`
                : '距上次事件: <b style="color:#6b7280;">暂无</b>'}
        </div>
    `);
    div.innerHTML = lines.join('');
}

// ====== 在主控制台 + 增强检测视图画火焰框 ======
function renderFireBoxesOnOverlays(d) {
    // 1) 主控制台实时巡逻图画框
    drawFireBoxOnOverlay(document.getElementById('cameraOverlay'), d, 'main');
    // 2) 增强检测视图画框
    drawFireBoxOnOverlay(document.getElementById('enhancedOverlay'), d, 'enhanced');
}

function drawFireBoxOnOverlay(overlay, d, scope) {
    if (!overlay) return;
    overlay.innerHTML = '';
    if (!d.active || d.w <= 0 || d.h <= 0) return;

    // 模型输入 320x240 -> overlay 显示尺寸按百分比适配
    const xPct = (d.x / MAIXCAM_CAM_W) * 100;
    const yPct = (d.y / MAIXCAM_CAM_H) * 100;
    const wPct = (d.w / MAIXCAM_CAM_W) * 100;
    const hPct = (d.h / MAIXCAM_CAM_H) * 100;

    const box = document.createElement('div');
    box.className = 'detection-box';
    box.style.left = xPct + '%';
    box.style.top  = yPct + '%';
    box.style.width = wPct + '%';
    box.style.height = hPct + '%';
    box.style.borderColor = '#ef4444';
    box.style.boxShadow = '0 0 0 2px rgba(239,68,68,0.3), 0 0 20px rgba(239,68,68,0.5)';

    const label = document.createElement('div');
    label.className = 'detection-label';
    label.style.left = xPct + '%';
    label.style.top  = yPct + '%';
    label.style.background = '#ef4444';
    label.textContent = `🔥 fire ${(d.score*100).toFixed(0)}%`;

    overlay.appendChild(box);
    overlay.appendChild(label);
}

// ====== 增强检测视图：统计卡片 + 对象列表 ======
function updateFireViewStats(d) {
    // 累计数字
    const tot = document.getElementById('totalObjects');
    if (tot) tot.textContent = d.totalDetect;
    const hr  = document.getElementById('highRiskCount');
    if (hr)  hr.textContent  = d.totalAlerts;
    const avg = document.getElementById('avgConfidence');
    if (avg) avg.textContent = d.active ? `${(d.score*100).toFixed(1)}%` : '0%';
    const fps = document.getElementById('frameRate');
    if (fps) fps.textContent = Math.round(1000 / Math.max(esp32Config.pollInterval, 1));

    // 对象列表
    const list = document.getElementById('objectList');
    if (!list) return;
    if (!d.active) {
        list.innerHTML = `
            <div style="text-align:center;color:#22c55e;padding:40px;">
                ✅ 当前无火焰目标<br>
                <small>系统运行正常 · 累计检测 ${d.totalDetect} 次</small>
            </div>`;
        return;
    }
    const det = {
        class: '火焰 fire',
        type: 'fire',
        confidence: d.score,
        risk: 'critical',
        color: '#ef4444',
        bbox: [d.x, d.y, d.x + d.w, d.y + d.h]
    };
    updateObjectList([det]);
    updateDetectionStats([det]);
}

// ============ MaixCam 数据应用 ============
function applyMaixcamData(m) {
    // 更新连接状态徽章
    const badge = document.getElementById('maixcamBadge');
    if (badge) {
        badge.classList.remove('online', 'offline', 'connecting');
        if (m.connected) {
            badge.textContent = 'MaixCam 在线';
            badge.classList.add('online');
        } else {
            badge.textContent = 'MaixCam 离线';
            badge.classList.add('offline');
        }
    }

    // 如果 ESP32 报告了 MaixCam 的 IP，自动同步到本地配置
    if (m.ip) {
        maixcamConfig.ip = m.ip;
        const ipInput = document.getElementById('maixcamIp');
        if (ipInput) ipInput.value = m.ip;
    }
    if (m.port) {
        maixcamConfig.port = m.port;
        const portInput = document.getElementById('maixcamPort');
        if (portInput) portInput.value = m.port;
    }

    // 显示 MaixCam 的检测结果（覆盖到增强检测视图）
    if (m.detections && Array.isArray(m.detections)) {
        // 同步到 currentDetections，用 MaixCam 给的 bbox 和 risk
        currentDetections = m.detections.map(d => ({
            class: d.class,
            type: d.class,           // 复用类型字段
            confidence: d.confidence,
            risk: d.risk,
            color: ({critical:'#ef4444', high:'#f59e0b', medium:'#3b82f6', low:'#22c55e'})[d.risk] || '#22c55e',
            bbox: d.bbox
        }));

        // 在主控制台的"实时巡逻视图"上画检测框（演示模式画面被覆盖时）
        if (!maixcamConfig.streamActive) {
            drawMaixcamDetectionsOnCamera(currentDetections);
        }

        // 更新增强检测视图
        const objectList = document.getElementById('objectList');
        if (objectList && !objectList.innerHTML.includes('检测已停止')) {
            updateObjectList(currentDetections);
            updateDetectionStats(currentDetections);
        }

        // 实时检测结果显示到主控制台
        if (currentDetections.length > 0) {
            const resultsDiv = document.getElementById('detectionResults');
            // 只在内容不同时刷新
            const sig = currentDetections.map(d => d.class + d.confidence.toFixed(2)).join('|');
            if (resultsDiv.dataset.maixcamSig !== sig) {
                resultsDiv.dataset.maixcamSig = sig;
                resultsDiv.innerHTML = '';
                currentDetections.forEach(d => {
                    const detDiv = document.createElement('div');
                    detDiv.className = `alert-item ${d.risk === 'critical' ? '' : d.risk === 'high' ? 'warning' : 'info'}`;
                    detDiv.innerHTML = `
                        <strong>${d.class}</strong> <span style="color:#22c55e">${(d.confidence*100).toFixed(1)}%</span><br>
                        风险: ${d.risk} | 来源: MaixCam
                    `;
                    resultsDiv.appendChild(detDiv);
                });
            }
        }
    }
}

// 在主控制台的 cameraFeed 上画 MaixCam 检测框（演示模式时）
function drawMaixcamDetectionsOnCamera(detections) {
    const overlay = document.getElementById('cameraOverlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    detections.forEach(d => {
        const [x1, y1, x2, y2] = d.bbox;
        const box = document.createElement('div');
        box.className = 'detection-box';
        box.style.left = x1 + 'px'; box.style.top = y1 + 'px';
        box.style.width = (x2 - x1) + 'px'; box.style.height = (y2 - y1) + 'px';
        box.style.borderColor = d.color;
        const label = document.createElement('div');
        label.className = 'detection-label';
        label.style.left = x1 + 'px'; label.style.top = y1 + 'px';
        label.style.background = d.color;
        label.textContent = `${d.class} ${(d.confidence*100).toFixed(0)}%`;
        overlay.appendChild(box);
        overlay.appendChild(label);
    });
}

// 根据ESP32的传感器数据模拟检测结果（仅演示模式下启用）
function updateDetectionFromEsp32(s) {
    if (esp32Config.mode !== 'demo') return;   // HTTP/WebSocket 模式下真实数据已由 applyEsp32Data 处理
    const detections = [];
    if (s.flameDetected) {
        detections.push({ class: 'fire', type: 'fire', confidence: 0.92, risk: 'critical', color: '#ef4444',
            bbox: [200, 150, 380, 300] });
    }
    if (s.smokeLevel > 50) {
        detections.push({ class: 'smoke', type: 'smoke', confidence: 0.5 + (s.smokeLevel / 200), risk: s.smokeLevel > 70 ? 'high' : 'medium', color: '#6b7280',
            bbox: [100, 80, 300, 250] });
    }
    if (s.personDetected) {
        detections.push({ class: 'person', type: 'person', confidence: 0.88, risk: 'medium', color: '#3b82f6',
            bbox: [400, 200, 520, 380] });
    }
    currentDetections = detections;

    if (document.getElementById('objectList') && !document.getElementById('objectList').innerHTML.includes('检测已停止')) {
        updateObjectList(detections);
        updateDetectionStats(detections);
    }
}

// ============ 覆盖原有控制函数 ============
// 当连接ESP32时，所有控制命令优先发送给设备
const _origMoveRobot = moveRobot;
moveRobot = function(direction) {
    // 先在前端模拟动作（让界面立即响应）
    _origMoveRobot(direction);
    // 真实发送给ESP32
    if (esp32Config.mode === 'websocket') {
        wsSend({ action: 'move', direction });
    } else if (esp32Config.mode === 'http') {
        httpSendAction('move', { direction });
    }
};

const _origStopRobot = stopRobot;
stopRobot = function() {
    _origStopRobot();
    if (esp32Config.mode === 'websocket') {
        wsSend({ action: 'move', direction: 'stop' });
    } else if (esp32Config.mode === 'http') {
        httpSendAction('move', { direction: 'stop' });
    }
};

const _origStartPatrol = startPatrol;
startPatrol = function() {
    _origStartPatrol();
    if (esp32Config.mode === 'websocket') {
        wsSend({ action: 'autoPatrol', enable: true });
    } else if (esp32Config.mode === 'http') {
        httpSendAction('autoPatrol', { enable: true });
    }
};

const _origPausePatrol = pausePatrol;
pausePatrol = function() {
    _origPausePatrol();
    if (esp32Config.mode === 'websocket') {
        wsSend({ action: 'autoPatrol', enable: false });
    } else if (esp32Config.mode === 'http') {
        httpSendAction('autoPatrol', { enable: false });
    }
};

const _origReturnToBase = returnToBase;
returnToBase = function() {
    _origReturnToBase();
    if (esp32Config.mode === 'websocket') {
        wsSend({ action: 'returnBase' });
    } else if (esp32Config.mode === 'http') {
        httpSendAction('returnBase');
    }
};

const _origClearAlerts = clearAlerts;
clearAlerts = function() {
    _origClearAlerts();
    if (esp32Config.mode === 'websocket') {
        wsSend({ action: 'clearAlert' });
    } else if (esp32Config.mode === 'http') {
        httpSendAction('clearAlert');
    }
};

const _origTestAlert = testAlert;
testAlert = function(alertType) {
    // 演示模式下保留原行为；连接ESP32时真实发送
    _origTestAlert(alertType);
    if (esp32Config.connected) {
        if (esp32Config.mode === 'websocket') {
            wsSend({ action: 'triggerAlert', type: alertType });
        } else if (esp32Config.mode === 'http') {
            httpSendAction('triggerAlert', { type: alertType });
        }
    }
};

// ============ 辅助函数 ============
function setConnStatus(status) {
    const el = document.getElementById('connStatus');
    if (!el) return;
    el.classList.remove('connected','esp32-connected','connecting','fire-alarm');
    if (status === 'connected') {
        el.textContent = '已连接';
        el.classList.add('esp32-connected');
    } else if (status === 'connecting') {
        el.textContent = '连接中';
        el.classList.add('connecting');
    } else if (status === 'fire') {
        el.textContent = '🔥 火警';
        el.classList.add('fire-alarm');
    } else {
        el.textContent = '未连接';
    }
}

function esp32Log(message, type = 'info') {
    const el = document.getElementById('esp32Log');
    if (!el) return;
    const color = type === 'success' ? 'log-success' :
                  type === 'error'   ? 'log-error'   :
                  type === 'warning' ? 'log-warning' : 'log-info';
    const time = new Date().toLocaleTimeString();
    el.innerHTML += `<div class="${color}">[${time}] ${escapeHtml(message)}</div>`;
    el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => 
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])
    );
}

// 加载保存的配置
(function loadSavedConfig() {
    try {
        const saved = localStorage.getItem('esp32Config');
        const c = saved ? JSON.parse(saved) : {};
        Object.assign(esp32Config, {
            mode:         c.mode         || 'http',
            ip:           c.ip           || '192.168.243.155',
            httpPort:     c.httpPort     || 80,
            wsPort:       c.wsPort       || 81,
            pollInterval: c.pollInterval || 1000,
            connected:    false
        });
        document.getElementById('connMode').value     = esp32Config.mode;
        document.getElementById('esp32Ip').value      = esp32Config.ip;
        document.getElementById('httpPort').value     = esp32Config.httpPort;
        document.getElementById('wsPort').value       = esp32Config.wsPort;
        document.getElementById('pollInterval').value = esp32Config.pollInterval;
    } catch(e) {}
})();

// 保存配置变化
['connMode','esp32Ip','httpPort','wsPort','pollInterval'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('change', () => {
            const save = {
                mode: document.getElementById('connMode').value,
                ip: document.getElementById('esp32Ip').value,
                httpPort: parseInt(document.getElementById('httpPort').value),
                wsPort: parseInt(document.getElementById('wsPort').value),
                pollInterval: parseInt(document.getElementById('pollInterval').value)
            };
            localStorage.setItem('esp32Config', JSON.stringify(save));
        });
    }
});

// ========================================================================
//                        MaixCam 视频流控制
// ========================================================================
// MaixCam 视频流候选路径（按优先级尝试）
//   优先直连 MaixCam（<img> 标签加载跨域图片/MJPEG 不受 CORS 限制，最直接）；
//   其次走本地 server.py 反向代理（备用，解决 AP 隔离/跨网段场景）。
const MAIXCAM_STREAM_PATHS = [
    // ---- 直连 MaixCam（优先，img 标签不受 CORS 限制）----
    '/stream',
    '/mjpeg',
    '/live',
    '/video',
    '/',
    '/jpg',
    // ---- 走本地 server.py 代理（备用，解决跨网段/AP隔离场景）----
    '/maixcam/stream',
    '/maixcam/mjpeg',
    '/maixcam/jpg',
    '/maixcam/live',
    '/maixcam/video',
    '/maixcam/'
];

function buildStreamCandidates(ip, port) {
    const out = [];
    for (const p of MAIXCAM_STREAM_PATHS) {
        if (p.startsWith('/maixcam/') || p === '/maixcam') {
            // 走本地服务器代理：相对路径即可（img.src 会自动补当前页面 origin）
            out.push(p);
        } else {
            out.push(`http://${ip}:${port}${p}`);
        }
    }
    return out.filter((v, i, arr) => arr.indexOf(v) === i);
}

// 切换 MaixCam 视频流显示
function toggleMaixcamStream() {
    if (maixcamConfig.streamActive) {
        stopMaixcamStream();
    } else {
        startMaixcamStream();
    }
}

function getStreamNodes() {
    return {
        mains: [
            { img: document.getElementById('maixcamStream'),
              ph:  document.getElementById('cameraPlaceholder'),
              info:document.getElementById('streamInfo') },
            { img: document.getElementById('enhancedMaixcamStream'),
              ph:  document.getElementById('enhancedPlaceholder'),
              info:document.getElementById('enhancedStreamInfo') }
        ]
    };
}

function applyStreamToAll(streamUrl, ip, port) {
    const { mains } = getStreamNodes();
    const ts = '?t=' + Date.now();
    mains.forEach(n => {
        if (!n.img) return;
        n.img.style.display = 'block';
        n.img.src = streamUrl + ts;
        const viaProxy = streamUrl.startsWith('/maixcam/');
        if (n.info) {
            n.info.textContent = viaProxy
                ? `MaixCam ${ip}:${port} · 代理 MJPEG 流`
                : `MaixCam ${ip}:${port} · MJPEG 实时流（直连）`;
        }
        if (n.ph) n.ph.style.display = 'none';
        // 去掉主控制台可能残留的 startCamera 演示占位文字
        const feed = n.img.closest('.camera-feed');
        if (feed) {
            const hint = feed.querySelector('.camera-demo-hint');
            if (hint) hint.remove();
        }
    });
}

function hideStreamOnAll() {
    const { mains } = getStreamNodes();
    mains.forEach(n => {
        if (!n.img) return;
        n.img.onerror = null;
        n.img.onload = null;
        n.img.src = '';
        n.img.style.display = 'none';
        if (n.ph) n.ph.style.display = '';
        if (n.info) n.info.textContent = '';
    });
}

// 启动 MaixCam MJPEG 视频流：按常见路径顺序探测，成功后同时给两张画面
function startMaixcamStream() {
    // 防重入：正在探测时不要重复调用
    if (maixcamConfig._probing) {
        esp32Log('MaixCam 视频连接中，稍候...', 'warning');
        return;
    }
    const ip = (document.getElementById('maixcamIp') || {}).value?.trim() || maixcamConfig.ip;
    const port = parseInt((document.getElementById('maixcamPort') || {}).value) || maixcamConfig.port;
    maixcamConfig.ip = ip;
    maixcamConfig.port = port;

    const candidates = buildStreamCandidates(ip, port);
    esp32Log(`📷 正在连接 MaixCam 视频流 ${ip}:${port}（直连优先，代理备用）...`, 'info');
    setMaixcamBadge('connecting');
    maixcamConfig.streamActive = false;
    maixcamConfig._probing = true;

    // 先把两张画面切换到 loading 态，清空旧 src
    hideStreamOnAll();

    // 判断候选是直连还是代理
    const isProxyUrl = u => u.startsWith('/maixcam');
    let directTried = false;

    // 串行探测，找到第一个能 onload 成功的
    let idx = 0;
    function tryNext() {
        if (idx >= candidates.length) {
            maixcamConfig._probing = false;
            setMaixcamBadge('offline');
            esp32Log(
                `❌ 所有 MaixCam 路径都失败。排查步骤：\n` +
                `  1) MaixCam 是否已运行 main.py（HTTP MJPEG 在 8080/stream）\n` +
                `  2) 电脑和 MaixCam 是否同一 Wi-Fi（浏览器直接访问 http://${ip}:${port}/stream 测试）\n` +
                `  3) 若 Run 能出画面但复位不行：在 MaixVision 终端运行 python /root/main.py 看报错\n` +
                `  4) 页面必须用 http://localhost:8080/ 打开（不能用 HTTPS / 文件://）`,
                'error'
            );
            hideStreamOnAll();
            return;
        }
        const url = candidates[idx++];
        const probe = new Image();
        let settled = false;
        const t0 = performance.now();
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            probe.onerror = null;
            probe.onload = null;
            if (ok) {
                const dt = Math.round(performance.now() - t0);
                applyStreamToAll(url, ip, port);
                maixcamConfig.streamActive = true;
                maixcamConfig._probing = false;
                setMaixcamBadge('online');
                esp32Log(`✅ MaixCam 视频流已连接（${dt}ms）：${url}`, 'success');
            } else {
                // 第一个路径失败时打一次提示
                if (idx === 1) {
                    esp32Log(`⚠️ 直连 ${url} 失败，继续尝试...`, 'warning');
                } else if (!directTried && isProxyUrl(url)) {
                    directTried = true;
                    esp32Log(`⚠️ 直连路径全部失败，尝试本地代理...`, 'warning');
                }
                tryNext();
            }
        };
        probe.onload = () => finish(true);
        probe.onerror = () => finish(false);
        // 直连路径超时 1.5s；代理路径给 3s（经过 server.py 中转稍慢）
        const timeout = isProxyUrl(url) ? 3000 : 1500;
        setTimeout(() => finish(false), timeout);
        probe.src = url + '?t=' + Date.now();
    }
    tryNext();
}

// 停止 MaixCam 视频流
function stopMaixcamStream() {
    maixcamConfig._probing = false;
    hideStreamOnAll();
    maixcamConfig.streamActive = false;
    setMaixcamBadge('offline');
    esp32Log('MaixCam 视频流已停止', 'warning');
}

// 应用 MaixCam 配置（把 IP/端口同步给 ESP32）
function applyMaixcamConfig() {
    const ip = document.getElementById('maixcamIp').value.trim();
    const port = parseInt(document.getElementById('maixcamPort').value) || 8080;
    if (!ip) {
        esp32Log('错误: 请填写 MaixCam 的 IP 地址', 'error');
        return;
    }
    maixcamConfig.ip = ip;
    maixcamConfig.port = port;

    // 保存到 localStorage
    localStorage.setItem('maixcamConfig', JSON.stringify({ ip, port }));

    // 把 MaixCam IP 告诉 ESP32（ESP32 后续可以从这个 IP 拉数据/代理视频）
    if (esp32Config.connected) {
        sendEsp32Command('set_maixcam_ip', { ip, port });
        esp32Log(`已通知 ESP32: MaixCam 地址 = ${ip}:${port}`, 'success');
    } else {
        esp32Log(`MaixCam 配置已保存: ${ip}:${port}（ESP32 未连接，未通知设备）`, 'warning');
    }

    // 如果视频流正在播放，重新加载
    if (maixcamConfig.streamActive) {
        startMaixcamStream();
    }
}

// MaixCam 拍照命令（通过 ESP32 转发）
function maixcamCapture() {
    if (!esp32Config.connected) {
        esp32Log('请先连接 ESP32 才能发送拍照命令', 'error');
        return;
    }
    sendEsp32Command('maixcam_capture', {});
    esp32Log('已通过 ESP32 向 MaixCam 发送拍照命令（照片保存在 MaixCam 上）', 'info');
}

// 设置 MaixCam 状态徽章
// 注意：有火焰时 applyFireHeaderStatus 会覆盖成红色"🔥 检测到火焰"，优先级更高
function setMaixcamBadge(status) {
    const badge = document.getElementById('maixcamBadge');
    if (!badge) return;
    // 若当前为火警状态（applyFireHeaderStatus 已写入），这里不再改写文字，只保留颜色样式
    if (lastFireData && lastFireData.active) {
        badge.classList.remove('online','offline','connecting');
        badge.classList.add('online');
        badge.style.background = '#ef4444';
        if (!badge.textContent.startsWith('🔥')) {
            badge.textContent = '🔥 检测到火焰';
        }
        return;
    }
    badge.style.background = '';
    badge.classList.remove('online', 'offline', 'connecting');
    if (status === 'online') {
        badge.textContent = 'MaixCam 实时';
        badge.classList.add('online');
    } else if (status === 'connecting') {
        badge.textContent = '连接中...';
        badge.classList.add('connecting');
    } else {
        badge.textContent = esp32Config.connected ? 'MaixCam 离线' : '演示模式';
        badge.classList.add('offline');
    }
}

// 统一发送 ESP32 命令（自动选择 WS 或 HTTP）
function sendEsp32Command(action, params = {}) {
    if (esp32Config.mode === 'websocket') {
        return wsSend({ action, ...params });
    } else if (esp32Config.mode === 'http') {
        return httpSendAction(action, params);
    }
    return false;
}

// 加载 MaixCam 配置
(function loadMaixcamConfig() {
    try {
        const saved = localStorage.getItem('maixcamConfig');
        if (saved) {
            const c = JSON.parse(saved);
            maixcamConfig.ip = c.ip || maixcamConfig.ip;
            maixcamConfig.port = c.port || maixcamConfig.port;
            const ipInput = document.getElementById('maixcamIp');
            const portInput = document.getElementById('maixcamPort');
            if (ipInput) ipInput.value = maixcamConfig.ip;
            if (portInput) portInput.value = maixcamConfig.port;
        }
    } catch(e) {}
})();

// 保存 MaixCam 配置变化
['maixcamIp', 'maixcamPort'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('change', () => {
            const ip = document.getElementById('maixcamIp').value;
            const port = parseInt(document.getElementById('maixcamPort').value) || 8080;
            localStorage.setItem('maixcamConfig', JSON.stringify({ ip, port }));
        });
    }
});
