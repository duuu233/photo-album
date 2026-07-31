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
    maxLength: deviceName.DEVICE_NAME_MAX_LEN
  },

  observers: {
    'visible,value': function (visible, value) {
      if (!visible) {
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
