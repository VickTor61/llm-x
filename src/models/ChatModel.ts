import _ from 'lodash'
import { types, Instance, detach, flow } from 'mobx-state-tree'

import { settingStore } from './SettingStore'
import { toastStore } from './ToastStore'

import base64EncodeImage from '../utils/base64EncodeImage'
import { OllmaApi } from '../utils/OllamaApi'

const MessageErrorModel = types.model({
  message: types.string,
  stack: types.maybe(types.string),
})

const MessageExtrasModel = types.model({
  error: types.maybe(MessageErrorModel),
})

export const MessageModel = types
  .model({
    fromBot: types.boolean,
    botName: types.maybe(types.string),
    content: types.optional(types.string, ''),
    image: types.maybe(types.string),
    uniqId: types.identifier,
    extras: types.maybe(MessageExtrasModel),
  })
  .actions(self => ({
    setError(error: Error) {
      self.extras ||= MessageExtrasModel.create()

      const { message, stack } = error

      self.extras.error = MessageErrorModel.create({ message, stack })
    },
  }))

export interface IMessageModel extends Instance<typeof MessageModel> {}

export const ChatModel = types
  .model({
    id: types.optional(types.identifierNumber, Date.now),
    name: types.optional(types.string, ''),
    messages: types.array(MessageModel),
    incomingMessage: types.safeReference(MessageModel),
    _incomingMessageAbortedByUser: types.maybe(types.boolean),
    previewImage: types.maybe(types.string),
  })
  .actions(self => ({
    afterCreate() {
      if (self.incomingMessage) {
        this.commitIncomingMessage()
      }
    },

    beforeDestroy() {
      OllmaApi.cancelStream()

      // we do not persist the message, get rid of the image too
      self.previewImage = undefined
    },

    setPreviewImage: flow(function* setFile(file?: File) {
      if (!file) {
        self.previewImage = undefined
        return
      }

      try {
        self.previewImage = yield base64EncodeImage(file)
      } catch (e) {
        toastStore.addToast(
          'Unable to read image, check the console for error information',
          'error',
        )

        console.error(e)
      }
    }),

    setName(name?: string) {
      if (name) {
        self.name = name
      }
    },

    deleteMessage(message: IMessageModel) {
      detach(message)

      _.remove(self.messages, message)
    },

    createIncomingMessage() {
      const uniqId = 'bot_' + Date.now()

      const incomingMessage = MessageModel.create({
        fromBot: true,
        botName: settingStore.selectedModel?.name,
        uniqId,
      })

      self.messages.push(incomingMessage)

      self.incomingMessage = incomingMessage

      return self.incomingMessage
    },

    commitIncomingMessage() {
      self.incomingMessage = undefined
      self._incomingMessageAbortedByUser = false
    },

    updateIncomingMessage(content: string) {
      self.incomingMessage!.content += content
    },

    abortGeneration() {
      self._incomingMessageAbortedByUser = true

      OllmaApi.cancelStream()
    },

    async generateMessage(incomingMessage: IMessageModel) {
      self.incomingMessage = incomingMessage
      incomingMessage.content = ''

      if (incomingMessage.extras) {
        incomingMessage.extras.error = undefined
      }

      try {
        for await (const message of OllmaApi.streamChat(self.messages, incomingMessage)) {
          this.updateIncomingMessage(message)
        }
      } catch (error: unknown) {
        if (self._incomingMessageAbortedByUser) {
          incomingMessage.setError(new Error('Stream stopped by user'))
        } else if (error instanceof Error) {
          incomingMessage.setError(error)

          // make sure the server is still connected
          settingStore.updateModels()
        }
      } finally {
        this.commitIncomingMessage()
      }
    },

    addUserMessage(content: string = '', image?: string) {
      if (!content && !image) return

      if (_.isEmpty(self.messages)) {
        this.setName(content.substring(0, 20))
      }

      const message = MessageModel.create({
        fromBot: false,
        content,
        uniqId: 'user_' + Date.now(),
        image,
      })

      self.messages.push(message)
    },
  }))
  .views(self => ({
    get isGettingData() {
      return !!self.incomingMessage
    },
  }))

export interface IChatModel extends Instance<typeof ChatModel> {}
