# **XT 电子纸相框通讯协议 XT ePaper Frame Communication Protocol**

# **V1.2**

|**Version**|**Modified By**|**Date**|**Description**|
|---|---|---|---|
|**版本号**|**修改人**|**修改日期**|**说明**|
|1.0|Lobos|20250717|开放基础版|
|1.1|Lobos|20250910|加入附件一 、设备修改服务器通讯参数|
|1.2|Lobos|20251118|修正部分描述|
|1.3|Song|20260410|新增协议|

### **1. 说明**

- 数据交换方式：硬件设备与服务器通信采用MQTT协议，基于发布订阅的模式进 行数据交换，默认使用小写字符。

- 上行数据：指硬件设备报给服务器的数据。

- 下行数据：指服务端下发给硬件设备的数据。

### **2. 通讯接口说明 Communication Interface Description**

###### **2.1 服务器通讯：Server Communication**

采用 MQTT 协议 v3.1.1 版本，QOS：1。

MQTT Topic：

上行数据发送 使用 Topic：/device/report/{clientid}

下行数据接收 使用 Topic：/inkjoyap/{clientid}

Uses MQTT protocol version 3.1.1, QOS: 1.

。MQTT Topics:

Uplink data transmission uses Topic: /device/report/{clientid}

Downlink data reception uses Topic: /inkjoyap/{clientid}

###### **2.2 设备与App蓝牙通信消息定义**

概述：定义了 手机 App 与 ESP32 设备 在蓝牙连接阶段（目前只有配网阶段）的 Blufi 自定义消息格式。

- 。 所有消息均以 JSON 格式 进行定义，字符采用 UTF-8 编码。

- 。 Blufi 数据帧(分片)最大支持 64 K 的数据内容

- 。 Blufi 相关通信代码实现均以乐鑫官方 Blufi demo 为基线来对齐

   - 。 BluFi 示例: bluetooth/blufi ：（需烧录至 ESP32）

   - 。 手机应用程序：EspBlufi

      - 。 Android 版本: EspBlufi For Android

      - 。 IOS 版本: EspBlufi For iOS

###### BluFi 协议详见官方文档

https://docs.espressif.com/projects/esp-

idf/zh_CN/latest/esp32/api-guides/ble/blufi.html

##### **2.2.1 消息方向**

|**方向**|**说明**|
|---|---|
|App → Device|手机端发送指令到设备|
|Device → App|设备回复执行结果或状态|

##### **2.2.2 数据结构通用字段**

|**字段名**|**类型**|**方向**|**说明**|
|---|---|---|---|
|action|string|双向|消息动作类型|
|msgid|string|App → Device|消息ID，毫秒级时间戳|
|date|object|双向|具体数据内容（结构由 action 决定）|
|date.result|int|Device → App|指令执行结果(如果有)：0=成功，非0=错误码|
|date.ack_msg|id string|Device → App|应答的消息ID|

##### **2.2.3 设置 MQTT 配置信息**

请求（App → Device）

```json
{
  "msgid": "1756108400173",
  // 消息ID，使用毫秒级时间戳
  "action": "mqtt_config",
  // 消息动作
  "data": {
    // 消息体
    "host": "mqtt.example.com",
    "port": 9000,
    "usr": "user123",
    "pwd": "p@ssw0rd"
  }
}
```

回复（Device → App）

```json
{
  "action": "mqtt_config_ack",
  // 消息动作
  "data": {
    // 消息体
    "result": 0,
    // 指令执行结果: 0 = 成功，非0 = 具体错误码
    "ack_msgid": "1756108400173",
    // 应答的消息ID // 可添加其他需要回传的数据
  }
}
```

##### **2.2.4 设置WiFi国家码（Country Code）**

用于根据地区差异调整 Wi-Fi 信道范围、发射功率。

乐鑫相关文档:

Wi-Fi 国家/地区代码

esp_wifi_set_country_code

Supported country codes are "01"(world safe mode) "AT","AU","BE","BG","BR", "CA","CH","CN","CY","CZ","DE","DK","EE","ES","FI","FR","GB","GR","HK","HR","HU", "IE","IN","IS","IT","JP","KR","LI","LT","LU","LV","MT","MX","NL","NO","NZ","PL","PT" , "RO","SE","SI","SK","TW","US"

The third octet of country code string is one of the following: ' ', 'O', 'I', 'X', otherwise it is considered as ' '.

请求（App → Device）

```json
{
  "msgid": "1756108400180",
  "action": "wifi_set_country_code",
  "data": {
    "country": "JP"   // ISO 3166-1 alpha-2 国家码，例如: CN, US, JP
  }
}
```

回复（Device → App）

```json
{
  "action": "wifi_set_country_code_ack",
  "data": {
    "result": 0,
    // 指令执行结果: 0 = 成功，非0 = 具体错误码
    "pending": 1,
    // 如需暂缓执行，回传 pending 字段。App 在解析时，会认为它的 优先级高于 result
    "ack_msgid": "1756108400180"  // 可添加其他需要回传的数据
  }
}
```

### **3. 消息**

##### **2.1 登录   Login**

APP扫码设备配网成功后，上报一次数据

###### **上行数据：Uplink Data:**

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|login|Message action|
|clientid||string||Device ID|
|msgid||string||Message ID，<br>usesmillisecond timestamp|
|stamac||string||MAC Address|
||ver|string||Firmware Version|
|data|statype|string||Base Station Type<br>1 、LINUX  Base Station<br>2 、Wi-Fi Base Station<br>3、Integrated Base Station & Tag<br>4 、PC Base Station（USB）|

###### JSON

{

**"action"** : **"login"** ,

**"clientid"** : **"A61F5AE3A12D"**

**"msgid"** : **"1712800547780"** ,

**"stamac"** : **"A61F5AE3A12D"** ,

**"data"** : {

**"ver"** : **"xtap_001"** ,

**"statype"** : **"1"**

- }

}

###### **下行数据：Downlink Data:**

|**Key**|**Type**|**Values**|**Description**|
|---|---|---|---|
|action|string|login_ack|Message action|
|msgid|string||Message ID，<br>usesmillisecond timestamp|
|stamac|string||MAC Address|
|date<br>ack_msgid|string||Message ID of the response|

###### JSON

{

**"action": "login_ack",**

**"msgid": "1750172946729",**

**"stamac": "6055F9FCE598"**

**"data": {**

**"ack_msgid": "1750172946729"**

   - }

- }

##### **2.2.心跳上报  Heartbeat**

###### **上行数据：Uplink Data:**

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|heart|Message actions|
|clientid||string||Device ID|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stamac||string||MAC Address|
||statype|int|type|Base Station Type<br>1 、LINUX  Base Station<br>2 、Wi-Fi Base Station<br>3、Integrated Base Station & Tag<br>4 、PC Base Station（USB）|
||ack|int||Response flag: (0: No Ack, 1: Ack)|
||wifi_ch|int|||
||wifi|string||WiFi switch on/off|
||ble|string||Bluetooth switch on/off|
||tf|string||TF card status: present/absent|
||tfsize|decimal||TF card capacity, in MB|
||tfused|decimal||Used space on the TF card, in MB|
|data|orientation|int||方向字段<br>当前取不到预留！<br>0: 默认方向（Portrait，竖屏）<br>90: 向左横屏（Landscape，设备顶部在左边）<br>180: 倒立（Upside-down）<br>270: 向右横屏（Landscape，设备顶部在右边）|
||battery|int||Battery percentage (0–100, as an integer)|
||wifi_rssi|int||WiFi signal strength (in dBm, negative<br>integers)|
||wifi_name|string||Wi-Fi name|
||ble_rssi|int||Bluetooth signal strength (in dBm, negative<br>integers)|
||version|string||ESP firmware version|
||country_code|string||Current country code|
||fpga_ver|string||FPGA version|

JSON

```json
{
  "action": "heart",
  "clientid": "30EDA0E44624",
  "msgid": "72074003686",
  "stamac": "30EDA0E44624",
  "data": {
    "type": 3,
    "ack": 1,
    "wifi_ch": 1,
    "wifi": "on",
    "ble": "off",
    "tf": "absent",
    "tfsize": 0,
    "tfused": 0,
    "orientation": 0,
    "battery": 86,
    "wifi_rssi": -46,
    "wifi_name": "aa",
    "ble_rssi": 0,
    "version": "0.1.2",
    "country_code": "1",
    "fpga_ver": "0.0.1"
  }
}
```

###### **下行数据：Downlink Data:**

###### 服务器收到上报数据后自动下发一条消息,告知接收到

|**Key`**|**Type**|**Values**|**Description**|
|---|---|---|---|
|action|string|heart_ack|Message actions|
|msgid|string||Message ID，<br>Uses millisecond timestamp|
|stamac|string||MAC Address|
|date<br>ack_msgid|string|||

```json
{
  "action": "heart_ack" ,
  "msgid": "1750172946729" ,
  "stamac": "6055F9FCE598" ,
  "data": {
    "ack_msgid": "1750172946729"
  }
}
```

##### **2.3 OTA指令   OTA instructions**

###### **下行数据：Downlink Data:**

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|ota|Message actions|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stamac||string||MAC Address|
||host|string||Server Domain Name or IP<br>Address|
|data|port|int||Port|
||path|string||File path and filename|

```json
{
  "action": "ota",
  "msgid": "7911d3429cc846",
  "stamac": "A61F5AE3A12D",
  "data": {
    "host": "10.41.1.84",
    "port": 25801,
    "path": "/ota/20240411/3ca9db5ad"
  }
}
```

###### **上行数据：Uplink Data:**

###### 通知服务端OTA执行结果

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|ota_ack|Message actions|
|clienti|d|string||Device ID|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stama|c|string||MAC Address|
|data|result|int||执行结果<br>参考文档末尾的状态码列表|
||ack_msgid|string||Message ID of the response|

{

"action": "ota_ack",

"clientid": "A61F5AE3A12D", "msgid": "1712800547780", "stamac": "A61F5AE3A12D", "data": { "result": 1,

"ack_msgid": "1712800547780" } }

##### **2.4 FPGA指令   FPGA instructions**

###### **下行数据：Uplink Data:**

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|fpga|Message actions|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stamac||string||MAC Address|
||host|string||Server Domain Name or IP<br>Address|
|data|port|int||Port|
||path|string||File path and filename|

```json
{
  "action": "fpga",
  "msgid": "7911d3429cc846",
  "stamac": "A61F5AE3A12D",
  "data": {
    "host": "10.41.1.84",
    "port": 25801,
    "path": "/fpga/20240411/3ca9db5ad"
  }
}
```

###### **上行数据：Uplink Data:**

###### 通知服务端FPGA执行结果

|**Key**|**Type**|**Values**|**Description**|
|---|---|---|---|
|action|string|fpga_ack|Message actions|
|clientid|string||Device ID|
|msgid|string||Message ID，Uses millisecond timestamp|
|stamac|string||MAC Address|
|data.result|int||执行结果，参考文档末尾的状态码列表|
|data.ack_msgid|string||Message ID of the response|

```json
{
  "action": "fpga_ack",
  "clientid": "A61F5AE3A12D",
  "msgid": "1712800547780",
  "stamac": "A61F5AE3A12D",
  "data": {
    "result": 1,
    "ack_msgid": "1712800547780"
  }
}
```

##### **2.5 Wifi系列模式配置指令  Configuration commands for Wi-Fi series modes**

###### **下行数据：Uplink Data:**

|**Key**|**Type**|**Values**|**Description**|
|---|---|---|---|
|action|string|wifimode|Message actions|
|msgid|string||Message ID，<br>Usesmillisecond timestamp|

|stamac|string|MAC Address|
|---|---|---|
|mode|int|功能码<br>0x01实时通讯模式<br>0x02定时通讯模式<br>0x03休眠模式|
|data<br>live|int|定时唤醒后保持时间(秒)<br>取值范围：60-65535<br>默认值：600|
|timingtime|int|定时通讯参数：定时时间(分钟)<br>取值范围：60-1440<br>默认值：240|

```json
{
  "action": "wifimode",
  "msgid": "1712800547780",
  "stamac": "A61F5AE3A12D",
  "data": {
    "mode": 1,
    "live": 600,
    "timingTime": 240
  }
}
```

###### **上行数据：Uplink Data:**

###### 通知服务端Wifi系列模式配置结果

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|wifimode_ack|Message actions|
|clientid||string||Device ID|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stamac||string||MAC Address|
||result|int||执行结果<br>参考文档末尾的状态码列表|
|d<br>|ack_msgid|string||应答的消息ID|
|ata<br>|mode|int||功能码<br>0x01实时通讯模式<br>0x02定时通讯模式<br>0x03停机模式|

```json
{
  "action": "wifimode_ack",
  "clientid": "A61F5AE3A12D",
  "msgid": "1712800547780",
  "stamac": "A61F5AE3A12D",
  "data": {
    "result": 1,
    "ack_msgid": "1712800547780",
    "mode": 1
  }
}
```

##### **2.6 Wifi定时休眠配置指令  Commands for configuring Wi-Fi sleep scheduling**

###### **下行数据：Uplink Data:**

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|wifi_sleep|Message actions|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stama|c|string||MAC Address|
||mode|int||休眠模式<br>0:关闭休眠<br>1:一次性<br>2:周期|
|data|live|int||休眠开始时间<br>APP保存的是当地时间，下发时会统一转为<br>UTC时区的时间<br>mode=1时格式:yyyy-MM-dd HH:mm<br>mode=2时格式:HH:mm|
||timingtime|int||休眠截止时间<br>APP保存的是当地时间，下发时会统一转为<br>UTC时区的时间<br>mode=1时格式:yyyy-MM-dd HH:mm<br>mode=2时格式:HH:mm|

```json
{
  "action": "wifimode",
  "msgid": "1712800547780",
  "stamac": "A61F5AE3A12D",
  "data": {
    "mode": 1,
    "beginTime": "",
    "endTime": ""
  }
}
```

###### **上行数据：Uplink Data:**

###### 通知服务端Wifi休眠配置结果

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|wifi_sleep_ack|Message actions|
|clienti|d|string||Device ID|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stama|c|string||MAC Address|
|~~d~~ata|result|int||执行结果<br>参考文档末尾的状态码列表|
||ack_msgid|string||应答的消息ID|

{

"action": "wifi_sleep_ack", "clientid": "A61F5AE3A12D", "msgid": "1712800547780", "stamac": "A61F5AE3A12D", "data": {

"result": 1,

"ack_msgid": "1712800547780" }

}

##### **2.7 设备配置下发指令  Issue device configuration commands**

###### **下行数据：Uplink Data:**

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|device_config|Message actions|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stama|c|string||MAC Address|
||batchkey|int||A random 12-character string|
|data|deviceId|int||The first 12 digits of the device ID|
||uid|int||User ID|

{

"action": "device_config",

"msgid": "1712800547780",

"stamac": "A61F5AE3A12D",

"data": {

"batchKey": "",

"deviceId": "",

"uid": ""

}

}

###### **上行数据：Uplink Data:**

###### 通知服务端设备配置下发指令

|**Key**||**Type**|**Values**<br>**Description**|
|---|---|---|---|
|action||string|device_config_ack Message actions|
|clienti|d|string|Device ID|
|msgid||string|Message ID，<br>Usesmillisecond timestamp|
|stama|c|string|MAC Address|
|~~d~~ata|result|int|执行结果<br>参考文档末尾的状态码列表|
||ack_msgid|string|应答的消息ID|

{ "action": "device_config_ack", "clientid": "A61F5AE3A12D", "msgid": "1712800547780", "stamac": "A61F5AE3A12D", "data": { "result": 1,

"ack_msgid": "1712800547780" } }

##### **2.8 播放单图指令 Playlist image instructions**

###### 目前服务端定时触发单图下发

###### **下行数据：Uplink Data:**

|**Key**|||**Type**|**Values**|**Description**|
|---|---|---|---|---|---|
|action|||string|play|Message actions|
|msgid|||string||Message ID，<br>Uses millisecond timestamp|
|stama|c||string||MAC Address|
||host||string||Server domain name or IP address|
|data|port||int||port|
||i|imgid|string||Document ID|
||mgs|imgurl|string||File path and filename|

```json
{
  "action": "play",
  "msgid": "1750169235376",
  "stamac": "3A:84:43:F6:F4:85",
  "data": {
    "host": "101.201.79.63",
    "port": 9000,
    "imgs": [
      {
        "imgid": "a6d134e2-e71e-44e6-be99-eb34f1c2af37",
        "imgurl": "/ufile/hh7man.bin"
      }
    ]
  }
}
```

###### **上行数据：Uplink Data:**

通知服务端播放指令的执行情况

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|play_ack|Message actions|
|clienti|d|string||Device ID|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stama|c|string||MAC Address|
|~~d~~ata|result|int||执行结果<br>参考文档末尾的状态码列表|
||ack_msgid|string||应答的消息ID|

```json
{
  "action": "play_ack",
  "clientid": "A61F5AE3A12D",
  "msgid": "1712800547780",
  "stamac": "A61F5AE3A12D",
  "data": {
    "result": 1,
    "ack_msgid": "1712800547780"
  }
}
```

##### **2.9 播放策略指令 Playback policy instructions**

服务端下发更新时间,定时到服务端拉图

###### **下行数据：Uplink Data:**

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|strategy|Message actions|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stamac||string||MAC Address|
||idle|int||轮播后是否休眠<br>0:休眠 1:不休眠|
||strategy|int||播放策略<br>1：顺序播放<br>2：随机播放|
||host|string||服务器域名或IP地址|
||port|int||端口|
|~~d~~t<br>|path|string||拉图路径<br>|
|aa<br>|updatetype|int||更新时间类型<br>1：固定时间<br>2：间隔时间|
||begintime|string||间隔时间-开始时间|
||endtime|string||间隔时间-截止时间|
||intervalminutes|int||间隔时间-间隔分钟数|
||updatedays|int||固定时间-更新频率(天)|
||updatetimelist|string array||固定时间-更新时分|

{ "action": "strategy",

"msgid": "1750169235376",

"stamac": "3A:84:43:F6:F4:85",

"data": {

"idle": 1,

"strategy": 1,

"host": "101.201.79.63",

"port": 9000,

"path": "/a/a.bin",

"updatetype": 1,

"begintime": "18:00",

"endtime": "19:00",

- "intervalminutes": 60,

"updatedays": 2,

"updatetimelist": ["11:00", "15:00"]

} }

###### **上行数据：Uplink Data:**

###### 通知服务端播放策略指令的执行情况，可以应答多个，每次更换图片时可以上报一条消 息

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|strategy_ack|Message actions|
|clienti|d|string||Device ID|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stama|c|string||MAC Address|
|data|result|int||执行结果<br>参考文档末尾的状态码列表|
||ack_msgid|string||应答的消息ID|

- {

- "action": "strategy_ack",

"clientid": "A61F5AE3A12D",

- "msgid": "1712800547780",

- "stamac": "A61F5AE3A12D",

"data": {

"result": 1,

"ack_msgid": "1712800547780" }

}

##### **2.10 播放策略+Bin指令 Playback policy + Bin command**

服务端下发更新时间和所有图片bin的列表,设备定时在本地根据策略计算要显示哪张图

###### **下行数据：Uplink Data:**

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|strategy|Message actions|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stamac||string||MAC Address|
|i|dle|int||轮播后是否休眠<br>0:休眠 1:不休眠|
||strategy|int||播放策略<br>1：顺序播放<br>2：随机播放|
||host|string||服务器域名或IP地址|
||port|int||端口|
|<br>|path|string||查询所有图片地址的路径|
|~~d~~ata<br>|updatetype|string||更新时间类型<br>1：固定时间<br>2：间隔时间|
||begintime|string||间隔时间-开始时间|
||endtime|string||间隔时间-截止时间|
|i|ntervalminutes|int||间隔时间-间隔分钟数|
||updatedays|int||固定时间-更新频率(天)|
||updatetimelist|string array||固定时间-更新时分|

```json
{
  "action": "strategy_bin",
  "msgid": "1750169235376",
  "stamac": "3A:84:43:F6:F4:85",
  "data": {
    "idle": 1,
    "strategy": 1,
    "host": "101.201.79.63",
    "port": 9000,
    "path": "/b/xxxx",
    "updatetype": 1,
    "begintime": "18:00",
    "endtime": "19:00",
    "intervalminutes": 60,
    "updatedays": 2,
    "updatetimelist": [
      "11:00",
      "15:00"
    ]
  }
}  // 查询所有图片地址路径返回的数据格式 {
"code": 0,
"msg": "success",
"data": {
  "host": "101.201.79.63",
  "port": 8080,
  "imgList": [
    "/inkjoy/a/b5b698ec-630e-4627-84dc-a372681d9215",
    "/inkjoy/a/f262e914-d080-4dfa-b0e4-b52c764681bc",
    "/inkjoy/a/ec408172-8f28-4667-8462-0c47d8761709",
    "/inkjoy/a/ef086b68-2b9b-4e22-a18b-52ca0f75824f"
  ]
}
}
```

##### **2.11 暂停轮播 Pause carousel**

###### 服务端删除当前生效的播放策略（对应播放策略、播放策略+Bin 这两种）后，下发此消 息通知给设备

**下行数据：Uplink Data:**

|**Key**|**Type **|**Values**|**Description**|
|---|---|---|---|
|action|string|strategy_stop|Message actions|
|msgid|string||Message ID，<br>Usesmillisecond timestamp|
|stamac|string||MAC Address|

// 消息示例 {

"action": "strategy_stop",

"msgid": "1750169235376",

"stamac": "3A:84:43:F6:F4:85" }

###### **上行数据：Uplink Data:**

###### 通知服务端是否停止成功

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|strategy_stop_ack|Message actions|
|clienti|d|string||Device ID|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stama|c|string||MAC Address|
|data|result|int||执行结果<br>参考文档末尾的状态码列表|
||ack_msgid|string||应答的消息ID|

{ "action": "strategy_stop_ack", "clientid": "A61F5AE3A12D", "msgid": "1712800547780", "stamac": "A61F5AE3A12D", "data": {

"result": 1, "ack_msgid": "1712800547780" } }

##### **2.12 播放TF卡内图片 Play images from the TF card**

通知设备播放TF卡内图片

###### **下行数据：Uplink Data:**

|**Key**|**Type **|**Values**|**Description**|
|---|---|---|---|
|action|string|play_tf|Message actions|
|msgid|string||Message ID，<br>Usesmillisecond timestamp|
|stamac|string||MAC Address|

// 消息示例

{

"action": "play_tf",

"msgid": "1750169235376",

"stamac": "3A:84:43:F6:F4:85"

}

###### **上行数据：Uplink Data:**

###### 通知服务端是否成功执行

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|play_tf_ack|Message actions|
|clienti|d|string||Device ID|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stama|c|string||MAC Address|
|data|result|int||执行结果<br>参考文档末尾的状态码列表|
||ack_msgid|string||应答的消息ID|

```json
{
  "action": "play_tf_ack",
  "clientid": "A61F5AE3A12D",
  "msgid": "1712800547780",
  "stamac": "A61F5AE3A12D",
  "data": {
    "result": 1,
    "ack_msgid": "1712800547780"
  }
}
```

##### **2.13 清空TF卡内容 Erase the contents of the TF card**

通知设备清空TF卡内容

###### **下行数据：Uplink Data:**

|**Key**|**Type **|**Values**|**Description**|
|---|---|---|---|
|action|string|clean_tf|Message actions|
|msgid|string||Message ID，<br>Usesmillisecond timestamp|
|stamac|string||MAC Address|
|date type|string||清空范围<br>ALL=全部,LOCAL=内置,OTHER=其他|

```json
{
  "action": "clean_tf",
  "msgid": "1750169235376",
  "stamac": "3A:84:43:F6:F4:85",
  "data": {
    "type": "ALL"
  }
}
```

###### **上行数据：Uplink Data:**

###### 通知服务端是否成功执行

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|clean_tf_ack|Message actions|
|clienti|d|string||Device ID|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stama|c|string||MAC Address|
|data|result|int||执行结果<br>参考文档末尾的状态码列表|
||ack_msgid|string||应答的消息ID|

```json
{
  "action": "clean_tf_ack",
  "clientid": "A61F5AE3A12D",
  "msgid": "1712800547780",
  "stamac": "A61F5AE3A12D",
  "data": {
    "result": 1,
    "ack_msgid": "1712800547780"
  }
}
```

##### **2.14 下载内置图片 Download the built-in images**

通知设备下载内置图片

###### **下行数据：Uplink Data:**

|**Key**||**Type **|**Values**|**Description**|
|---|---|---|---|---|
|action||string|down_int_img|Message actions|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stamac||string||MAC Address|
||host|string||Server domain name or IP address|
|date<br>|port|int||port|
||path|string||Retrieve the paths of all image URLs|

```json
{
  "action": "down_int_img",
  "msgid": "1750169235376",
  "stamac": "3A:84:43:F6:F4:85",
  "data": {
    "host": "101.201.79.63",
    "port": 8080,
    "path": "/b/xxxx",
  }
}
```

// 查询所有图片地址路径返回的数据格式

/* FACTORY=出厂页面 SET=设置页面 NO_WIFI=无wifi提示 LOW_BATTORY=低电量提示 LOW_POWER_OFF=低电量关机页面 CONNECTED=连接页面

数据格式:[x,y,w,h,sum,path]//[坐标X,坐标Y,图片宽,图片高,图片数据CRC16校验值, 图片地址]如坐标X、坐标Y都为0,则表示使用默认坐标 */ { "code": 0, "msg": "success", "data": { "host": "mf.ink.00r.top", "port": 443, "bins": { "SET": [ "0", "0", "1200", "1600",

"21455", "/offical/config/intimg/img_set.bin" ], "FACTORY": [ "0", "0", "632", "432", "207", "/offical/config/intimg/img_factory.bin" ], "NO_WIFI": [ "0", "0", "912", "1168", "46240", "/offical/config/intimg/img_no_wifi.bin" ], "CONNECTED": [ "0", "0", "1200", "1600", "xxx", "/offical/config/intimg/img_connected.bin" ], "LOW_BATTORY": [ "0", "0", "632", "106", "46331", "/offical/config/intimg/img_low_batt.bin" ], "LOW_POWER_OFF": [ "0", "0", "632", "106", "50686", "/offical/config/intimg/img_low_power_off.bin" ] } } }

###### **上行数据：Uplink Data:**

###### 通知服务端是否成功执行

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|down_int_img_ack|Message actions|
|clienti|d|string||Device ID|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stama|c|string||MAC Address|
|data|result|int||执行结果<br>参考文档末尾的状态码列表|
||ack_msgid|string||应答的消息ID|

```json
{
  "action": "down_int_img_ack",
  "clientid": "A61F5AE3A12D",
  "msgid": "1712800547780",
  "stamac": "A61F5AE3A12D",
  "data": {
    "result": 1,
    "ack_msgid": "1712800547780"
  }
}
```

##### **2.15 刷新图片 Refresh image**

通知设备清空TF卡内容

###### **下行数据：Uplink Data:**

|**Key**|**Type **|**Values**|**Description**|
|---|---|---|---|
|action|string|image_refresh|Message actions|
|msgid|string||Message ID，<br>Usesmillisecond timestamp|
|stamac|string||MAC Address|

- // 消息示例

{

- "action": "image_refresh", "msgid": "1750169235376", "stamac": "3A:84:43:F6:F4:85"

- }

###### **上行数据：Uplink Data:**

|**Key**|**Type**|**Values**|**Description**|
|---|---|---|---|
|action|string|image_refresh_ack|Message actions|
|msgid|string||Message ID，<br>Usesmillisecond timestamp|
|stamac|string||MAC Address|

- // 消息示例

- {

   - "action": "image_refresh_ack", "msgid": "1750169235376", "stamac": "3A:84:43:F6:F4:85"

- }

##### **2.16 国家码变更通知 Notice of Change to the National Code**

通知设备国家码变更

###### **下行数据：Uplink Data:**

|**Key**||**Type **|**Values**|**Description**|
|---|---|---|---|---|
|action||string|country|Message actions|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stamac||string||MAC Address|
|date|country_code|string||National Code|

```json
{
  "action": "country",
  "msgid": "1750169235376",
  "stamac": "3A:84:43:F6:F4:85",
  "data": {
    "country_code": "1"
  }
}
```

###### **上行数据：Uplink Data:**

|**Key**||**Type**|**Values**|**Description**|
|---|---|---|---|---|
|action||string|country_ack|Message actions|
|clienti|d|string||Device ID|
|msgid||string||Message ID，<br>Usesmillisecond timestamp|
|stama|c|string||MAC Address|
|data|result|int||执行结果<br>参考文档末尾的状态码列表|
||ack_msgid|string||应答的消息ID|

```json
{
  "action": "country_ack",
  "clientid": "A61F5AE3A12D",
  "msgid": "1712800547780",
  "stamac": "A61F5AE3A12D",
  "data": {
    "result": 1,
    "ack_msgid": "1712800547780"
  }
}
```

##### **2.17 关机通知 Shutdown notification**

通知服务器设备即将关机

###### **上行数据：Uplink Data:**

|**Key**|**Type **|**Values**|**Description**|
|---|---|---|---|
|action|string|shutdown|Message actions|
|msgid|string||Message ID，<br>Usesmillisecond timestamp|
|stamac|string||MAC Address|

- // 消息示例 {

   - "action": "shutdown",

   - "msgid": "1750169235376",

   - "stamac": "3A:84:43:F6:F4:85"

- }

###### **下行数据：Uplink Data:**

###### 通知设备收到

|**Key**|**Type**|**Values**|**Description**|
|---|---|---|---|
|action|string|shutdown_ack|Message actions|
|clientid|string||Device ID|
|msgid|string||Message ID，<br>Usesmillisecond timestamp|
|stamac|string||MAC Address|
|date ack_msgid|int||应答的消息ID|

- { "action": "shutdown_ack",

   - "clientid": "A61F5AE3A12D",

   - "msgid": "1712800547780",

   - "stamac": "A61F5AE3A12D",

   - "data": {

   - "ack_msgid": "1712800547780"

   - }

- }

##### **2.18 设备标签上报 Device station tag reporting**

###### **上行数据：Uplink Data:**

|**Key**|**Type **|**Values**|**Description**|
|---|---|---|---|
|action|string|login|Message actions|
|clientid|string||Device ID|
|msgid|string||Message ID，<br>Usesmillisecond timestamp|
|stamac|string||MAC Address|
|data|int array||蓝牙标签信号强度：1字节<br>标签MAC地址：6字节<br>其他上报信息：参考下图|

|**上报类型**<br>**(1B)**|**硬件版本**<br>**(1B)**|<br>**软件版本**<br>**(2B)**|<br>**设备编码**<br>**(2B)**<br>|<br>**电量**<br>**（1B）**|<br>**发射功率**<br>**（1B）**|**安全等级**<br>**(1B)**|**参数类型**<br>**(1B)**|**参数**<br>**(≥14B)**|
|---|---|---|---|---|---|---|---|---|
|0-255|0-255|||0-100|||||

2.上报类型:标签上报类型(兼容旧版本以区分广播包数据结构;本新协议:0x03:漫游上报 0x04: 标签上报(带唤醒)0xFE:可连接广播0xFD:标签上报(无需唤醒)0xFC:重连广播;其它:保留) 3.硬件版本:产品的硬件版本,高 4位表示主版本号(0-F)，低4位表示次版本号(0-F)

4.软件版本: 左高右低,高字节高 4位主版本号(0-F),低4位次版本号(0-F),低字节位(0-255)。

例如:0x1002，表示版本 1.0.2

5.设备编码:设备的编码DD，作为查询产品信息的标识

6.电量:设备电池电量百分比，0~100%

7.发射功率:高 4bit 表示芯片型号，低 4bit 表示发射功率

- 8.安全等级: 预留目0x01:不认证不加密   0x02 :license认证不加密      0x03:认证+加密 9.参数类型&参数:

|类型|参数|
|---|---|
|0x00|默认不带参数|
|0x01|分组，2Bytes参数，表示分组号|
|0x02|MAC地址，6Bytes 参数|

{

"action": "uptag",

"clientid": "A61F5AE3A12D",

"msgid": "1712799763896",

"stamac": "A61F5AE3A12D",

"data": [170, 49, 56, 5, 0, 111, 52, 253, 1, 16, 16, 0, 3, 87, 6, 255, 255]

}

## 4. **状态码定义表 Status Code Definition Table**

|**Description**|**Code**|
|---|---|
|收到下行数据，需要 ack，并且无异常情况<br>Downlink received, ACK required, no error|100|
|获取 FLASH 地址失败<br>Failed to get FLASH address|101|
|获取 FTP 服务器失败<br>Failed to get FTP server|102|
|获取文件大小失败<br>Failed to get file size|103|
|下载文件失败<br>Failed to download file|104|
|添加设备列表失败<br>Failed to add device to list|105|
|指令添加成功<br>Command added successfully|106|
|下载图片或文件成功<br>Image/file downloaded successfully|107|
|连接蓝牙设备超时<br>Bluetooth device connection timeout|110|
|指令执行失败<br>Command execution failed|112|
|执行成功<br>Execution successful|113|
|文件发送失败<br>File transmission failed|114|
|STA 获取 flash 地址失败<br>STA failed to get flash address|115|
|STA 获取文件大小失败<br>STA failed to get file size|116|
|STA 添加设备列表失败<br>STA failed to add device to list|117|
|STA 文件发送失败<br>STA file transmission failed|118|
|下载成功<br>Download successful|255|
|文件发送到蓝牙主机失败<br>File transmission to Bluetooth host failed|109|

## **5. 附件一. 设备修改服务器通讯参数**

**Appendix I. Device Modifies Server Communication Parameters**

#### 方法 1：

设备进入配网模式(操作见使用说明书)，设备会建立一个 WIFI 热点， 连接其 热点后，通过浏览器访问设置页面可设置设备参数。

**Method 1**

Enter the device's network configuration mode (see user manual). The device will create a Wi-Fi hotspot. Connect to this hotspot and access the configuration page via a web browser to set device parameters.

###### 操作过程如下：

通过电脑或手机连接设备热点，热点名称为"XT_ESP_"+(设备 MAC 地址 后 4 位) ，密码为 1234567890 连接后，浏览器访问 192.168.4.1，

服务器主要修改这 4 项：Server IP 、Server Port 、User 、 Password，修  改 后点 SET 进行保存。如要立刻重启可在 Sys Reset 栏中点击 RESET 重启设 备。

###### **Procedure:**

1. Connect your computer or phone to the device's hotspot.

Hotspot Name:"XT_ESP_" + (last 4 digits of device MAC address)

Password: 1234567890

2. After connecting, open a browser and visit 192.168.4.1.

3. Modify the following 4 main server parameters: Server IP, Server Port, User, Password. Click SET to save.

4. To reboot immediately, click RESET in the Sys Reset section.

![热点名称](images/p37_1_346x448.png)

![浏览器地址](images/p37_2_316x186.png)

![服务器配置部分参数](images/p37_3_447x590.png)

#### 方法 2

设备进入配网模式(操作见使用说明书) ，手机可连接 BLE 设备进行设置， BLE 设 备名 IJ_(MAC 地址) ，可通过 BluFi 协议的自定义协议 ，发送配置数据    来修改 服务器通讯参数。

###### **Method 2**

Enter the device's network configuration mode (see user manual). A mobile phone can connect to the BLE device for configuration.

BLE Device Name: IJ_(MAC Address)

Server communication parameters can be modified by sending

configuration data via the custom protocol within the BluFi protocol. 注意：设备版本 V0.1.1 及以上才支持

注意：设备版本 V0.2.7 及以上"broker"字段已修改为"host" 主要修改这 4 个参数： "host" "port" "usr" "pwd"，

Note: Supported from device firmware version V0.1.1 and above.

Note: The field "broker" has been changed to "host" from firmware version V0.2.7 and above.

The main parameters to modify are: "host", "port", "usr", "pwd".

参考数据： **Reference Data:**

```json
{
  "msgid": "1756108400173",
  "action": "mqtt_config",
  "data": {
    "host": "192.168.1.1",
    "port": 1883,
    "usr": "device",
    "pwd": "1234567890ab"
  }
}
```

###### 使用 EspBluFi 示例操作过程如下：

The operation process using the EspBluFi example app is as follows:

![EspBluFi 操作示例 1](images/p39_1_269x443.png)

![EspBluFi 操作示例 2](images/p39_2_265x444.png)
