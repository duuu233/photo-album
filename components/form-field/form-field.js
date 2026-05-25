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
