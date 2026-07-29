window.addEventListener('DOMContentLoaded', async () => {
  const api = window.electronAPI
  try {
    const challenge = await api.adminAcquirePhoneAuthChallenge()
    const send = challenge.success
      ? await api.adminSendPhoneAuthCode('13800138000', challenge.challengeToken)
      : challenge
    const firstVerify = await api.adminVerifyPhoneAuthCode('13800138000', '123456')
    const setPassword = await api.adminSetPassword('password-123')
    const secondChallenge = await api.adminAcquirePhoneAuthChallenge()
    const secondSend = secondChallenge.success
      ? await api.adminSendPhoneAuthCode('13800138000', secondChallenge.challengeToken)
      : secondChallenge
    const secondVerify = await api.adminVerifyPhoneAuthCode('13800138000', '123456')
    const phonePasswordLogin = await api.adminLogin('13800138000', 'password-123')
    const legacyLogin = await api.adminLogin('legacy-user', 'password-123')
    api.reportPhoneAuthE2eResult({
      challenge,
      send,
      firstVerify,
      setPassword,
      secondChallenge,
      secondSend,
      secondVerify,
      phonePasswordLogin,
      legacyLogin,
    })
  } catch (error) {
    api.reportPhoneAuthE2eResult({
      fatal: { success: false, message: String(error) },
    })
  }
})
