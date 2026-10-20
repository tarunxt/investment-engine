"""Presentation filtering only; existing mail delivery guards stay authoritative."""
CORE_MAIL_ACTIONS=('mail.password_reset','mail.stage2_position_warning')
def preference_visible(item,modules):
    if item['key'] in {'password_reset','stage2_position_warning'}:return True
    segments={'Zerodha':'zerodha_rebalance','IndMoney':'indmoney_us','Bullpen':'bullpen_research'}
    return any(segments.get(segment) in modules for segment in item.get('segments',()))
