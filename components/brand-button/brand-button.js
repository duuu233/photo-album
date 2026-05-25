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
