// 「选择投屏设备」底部弹层（2026-08-13 需求 2/3）。AI 对话页与图片详情页共用。
//
// 为什么做成组件：两处此前各抄了一份 wxml + 一套样式（.device-sheet / .picker-sheet），
// 连交互都同构，改一处必漏另一处 —— 本轮「不默认选中 + 加连接按钮」正是两处都要改的那种需求。
//
// 选中态**由组件自己持有**：它是这一屏内部的临时状态，页面拿去也没别的用处；
// 每次打开重置为空（不默认选中），页面只需在用户按下按钮时收到选了哪台。
Component({
  properties: {
    show: {
      type: Boolean,
      value: false
    },
    loading: {
      type: Boolean,
      value: false
    },
    // 每项需带 pickerId（这一屏内的行标识，页面负责生成）；展示读 name/productDeviceId
    devices: {
      type: Array,
      value: []
    },
    title: {
      type: String,
      value: '选择投屏设备'
    },
    desc: {
      type: String,
      value: '选择要投屏的电子纸设备，点击下方按钮开始连接'
    },
    confirmText: {
      type: String,
      value: '连接并投屏'
    }
  },

  data: {
    selectedId: ''
  },

  observers: {
    show: function (show) {
      // 每次打开都从「未选中」开始（需求：不要默认选中）。
      // 关闭时也清掉：下次打开若因数据未变而没触发 setData，也不会残留上一次的选中态。
      if (this.data.selectedId) {
        this.setData({ selectedId: '' })
      }
      void show
    }
  },

  methods: {
    noop() {},

    onSelect(event) {
      const id = String(event.currentTarget.dataset.id || '')
      if (!id) {
        return
      }
      this.setData({ selectedId: id })
    },

    onConfirm() {
      const selectedId = this.data.selectedId
      if (!selectedId) {
        return // 置灰态：没选设备时按钮不做任何事（wxml 里同时给了灰色观感）
      }
      const index = (this.data.devices || []).findIndex(
        item => item && item.pickerId === selectedId
      )
      if (index < 0) {
        return
      }
      this.triggerEvent('confirm', {
        device: this.data.devices[index],
        index
      })
    },

    onCancel() {
      this.triggerEvent('cancel')
    }
  }
})
