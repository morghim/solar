import React from "react"
import { useTranslation } from "react-i18next"
import { Horizon, Memo, Transaction } from "stellar-sdk"
import Tooltip from "@material-ui/core/Tooltip"
import CheckIcon from "@material-ui/icons/Check"
import UpdateIcon from "@material-ui/icons/Update"
import { useIsMobile } from "~Generic/hooks/userinterface"
import { Account } from "~App/contexts/accounts"
import { AccountData } from "~Generic/lib/account"
import { signatureMatchesPublicKey } from "~Generic/lib/stellar"
import { Address } from "~Generic/components/PublicKey"
import MemoMessage from "~Transaction/components/MemoMessage"
import { SummaryDetailsField, SummaryItem } from "./SummaryItem"

function SignerStatus(props: { hasSigned: boolean; style?: React.CSSProperties }) {
  const { t } = useTranslation()
  const Icon = props.hasSigned ? CheckIcon : UpdateIcon
  return (
    <Tooltip
      title={
        props.hasSigned
          ? t("account.transaction-review.signer-status.tooltip.has-signed")
          : t("account.transaction-review.signer-status.tooltip.has-not-signed")
      }
    >
      <Icon style={{ opacity: props.hasSigned ? 1 : 0.5, ...props.style }} />
    </Tooltip>
  )
}

// tslint:disable-next-line no-shadowed-variable
const Signer = React.memo(function Signer(props: {
  hasSigned: boolean
  signer: Horizon.AccountSigner | { key: string; weight: number }
  style?: React.CSSProperties
  transaction: Transaction
}) {
  const isSmallScreen = useIsMobile()

  return (
    <div style={{ display: "flex", alignItems: "center", ...props.style }}>
      <SignerStatus hasSigned={props.hasSigned} style={{ fontSize: "100%", marginRight: 8 }} />
      <div style={{ whiteSpace: "nowrap" }}>
        <Address
          address={props.signer.key}
          style={{ display: "inline-block", fontWeight: "normal", minWidth: 480 }}
          variant={isSmallScreen ? "short" : "full"}
        />
      </div>
    </div>
  )
})

export function Signers(props: {
  accounts: Account[]
  accountData: AccountData
  transaction: Transaction
  style?: React.CSSProperties
}) {
  const threshold = props.accountData.thresholds.high_threshold || 1
  const { t } = useTranslation()

  // TODO: We should not get the signers from the source account data, but either
  //       a) from the signature request or
  //       b) by taking the tx source and all operation source accounts into account
  const headingDetails =
    props.accountData.signers.length === 1
      ? t("account.transaction-review.signers.heading-details.single-signature")
      : props.accountData.signers.every(signer => signer.weight === 1)
      ? t(
          "account.transaction-review.signers.heading-details.default-signatures",
          `${threshold} of ${props.accountData.signers.length} multi-signature`,
          { threshold, length: props.accountData.signers.length }
        )
      : t("account.transaction-review.signers.heading-details.custom-consensus")

  return (
    <SummaryItem>
      {props.accountData.signers.map((signer, index) => (
        <SummaryDetailsField
          key={signer.key}
          label={
            index === 0
              ? t("account.transaction-review.signers.label", `Signers (${headingDetails})`, {
                  details: headingDetails
                })
              : undefined
          }
          value={
            <Signer
              hasSigned={props.transaction.signatures.some(signature =>
                signatureMatchesPublicKey(signature, signer.key)
              )}
              signer={signer}
              transaction={props.transaction}
            />
          }
        />
      ))}
    </SummaryItem>
  )
}

export function TransactionMemo(props: { memo: Memo; style?: React.CSSProperties }) {
  const { t } = useTranslation()
  if (props.memo.type === "none" || !props.memo.value) return null

  const typeLabel = props.memo.type.substr(0, 1).toUpperCase() + props.memo.type.substr(1)

  return (
    <SummaryItem>
      <SummaryDetailsField
        fullWidth
        label={t("account.transaction-review.transaction-memo.label", `${typeLabel} Memo`, { type: typeLabel })}
        value={<MemoMessage memo={props.memo} />}
      />
    </SummaryItem>
  )
}
