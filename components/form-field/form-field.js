// 通用表单输入项组件：封装标签、输入框、清除按钮、右侧操作（如获取验证码）与错误提示。
// 自身不存值，所有交互通过 triggerEvent 上报给父页面，由父页面维护数据（受控组件）。
Component({
  properties: {
    name: {
      type: String,
      value: ''
    },
    label: {
      type: String,
      value: ''
    },
    value: {
      type: String,
      value: ''
    },
    placeholder: {
      type: String,
      value: ''
    },
    type: {
      type: String,
      value: 'text'
    },
    password: {
      type: Boolean,
      value: false
    },
    maxlength: {
      type: Number,
      value: 140
    },
    confirmType: {
      type: String,
      value: 'done'
    },
    clearable: {
      type: Boolean,
      value: true
    },
    rightText: {
      type: String,
      value: ''
    },
    rightDisabled: {
      type: Boolean,
      value: false
    },
    hint: {
      type: String,
      value: ''
    },
    error: {
      type: String,
      value: ''
    }
  },

  methods: {
    // 输入变化上报：带上 name 便于父页面区分是哪个字段
    handleInput(e) {
      this.triggerEvent('input', {
        name: this.data.name,
        value: e.detail.value
      })
    },

    handleBlur(e) {
      this.triggerEvent('blur', {
        name: this.data.name,
        value: e.detail.value
      })
    },

    clearValue() {
      this.triggerEvent('input', {
        name: this.data.name,
        value: ''
      })
      this.triggerEvent('clear', {
        name: this.data.name
      })
    },

    // 右侧操作（如“获取验证码”）：禁用态不触发
    handleRightTap() {
      if (this.data.rightDisabled) {
        return
      }

      this.triggerEvent('righttap', {
        name: this.data.name
      })
    }
  }
})
