export const OTP_EMAIL_SUBJECT = 'Your OffooLive Verification Code'

export function buildOtpEmailBody(otp: string): { text: string; html: string } {
  const text = `Your OTP is:

${otp}

This OTP expires in 5 minutes.`

  const html = `
<!doctype html>
<html>
  <body>
    <p>Your OTP is:</p>
    <p style="font-size:24px;font-weight:700;letter-spacing:4px;">${otp}</p>
    <p>This OTP expires in 5 minutes.</p>
  </body>
</html>`.trim()

  return { text, html }
}
