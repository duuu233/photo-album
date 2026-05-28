// 品牌风格按钮组件：支持多种样式(variant)、尺寸、图标、加载/禁用态及微信 open-type（如获取手机号）。
Component({
  properties: {
    text: {
      type: String,
      value: ''
    },
    variant: {
      type: String,
      value: 'primary'
    },
    size: {
      type: String,
      value: 'normal'
    },
    icon: {
      type: String,
      value: ''
    },
    loading: {
      type: Boolean,
      value: false
    },
    disabled: {
      type: Boolean,
      value: false
    },
    block: {
      type: Boolean,
      value: true
    },
    openType: {
      type: String,
      value: ''
    }
  },

  methods: {
    // 点击上报：禁用或加载中时拦截，避免重复触发
    handleTap(e) {
      if (this.data.disabled || this.data.loading) {
        return
      }

      this.triggerEvent('tap', e.detail)
    },

    handlePhoneNumber(e) {
      this.triggerEvent('getphonenumber', e.detail)
    }
  }
})
