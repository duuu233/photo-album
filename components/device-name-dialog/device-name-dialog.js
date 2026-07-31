const deviceName = require('../../utils/device-name')

Component({
  properties: {
    visible: {
      type: Boolean,
      value: false
    },
    value: {
      type: String,
      value: ''
    },
    saving: {
      type: Boolean,
      value: false
    },
    title: {
      type: String,
      value: '修改设备名称'
    },
    cancelText: {
      type: String,
      value: '取消'
    },
    confirmText: {
      type: String,
      value: '保存'
    }
  },

  data: {
    inputValue: '',
    inputLength: 0,
    maxLength: deviceName.DEVICE_NAME_MAX_LEN,
    // 键盘弹起时弹窗整体上移的像素数（= 键盘高度 / 2，见 wxml 键盘避让注释）
    dialogOffset: 0
  },

  observers: {
    'visible,value': function (visible, value) {
      if (!visible) {
        // 关闭时把键盘偏移清零，下次打开不会带着上一次的上移量出场
        if (this.data.dialogOffset) {
          this.setData({ dialogOffset: 0 })
        }
        return
      }
      const inputValue = String(value || '')
      this.setData({
        inputValue,
        inputLength: Array.from(inputValue).length
      })
    }
  },

  methods: {
    noop() {},

    // 键盘高度变化：弹窗是 fixed 定位、adjust-position 顶不动它，只能自己让位。
    // 可视区从 H 缩到 H-kb，垂直居中的弹窗上移 kb/2 即重新落在剩余空间正中，
    // 底部「取消/保存」两个按钮不再被键盘盖住。收起键盘时 height 回 0，偏移自动归零。
    onKeyboardHeightChange(e) {
      const height = Number((e && e.detail && e.detail.height) || 0)
      const dialogOffset = height > 0 ? Math.round(height / 2) : 0
      if (dialogOffset !== this.data.dialogOffset) {
        this.setData({ dialogOffset })
      }
    },

    onInput(e) {
      const inputValue = e.detail.value || ''
      this.setData({
        inputValue,
        inputLength: Array.from(inputValue).length
      })
    },

    onCancel() {
      if (!this.data.saving) {
        this.triggerEvent('cancel')
      }
    },

    onConfirm() {
      if (this.data.saving) {
        return
      }
      const checked = deviceName.validateDeviceName(this.data.inputValue)
      if (!checked.ok) {
        wx.showToast({ title: checked.message, icon: 'none' })
        return
      }
      this.triggerEvent('confirm', { value: checked.name })
    }
  }
})
