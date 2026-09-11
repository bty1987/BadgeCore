# SaleSmart 全量页面清单（2026-09-11 代码包重抓）

> 来源：官网主包 index.js（2.5MB）+ 92 个懒加载分包 + vendor（10.7MB），存于 research/code/（gitignore，不入库）。
> 提取方法：路由表 meta{code,name} + path 全量正则。共 121 条路由、43 个命名管理页。

## 命名管理页（43）

- 业务洞察分类（insight_category）
- 业务洞察模板（insight_template）
- 产品类型（product）
- 任务模型（sales_task_model）
- 使用情况（usage_status）
- 信息收集（info_collection）
- 全局配置（global_configuration）
- 分类管理（sales_solution_classify）
- 员工名册（udp_orgoumgmt）
- 商品管理（sales_product_manage）
- 场景应对模型（scenario_based_coping_model）
- 字段设置（lead_field）
- 客户列表（customer_list）
- 客户字段设置（customer_field_set）
- 客户状态（customer_status）
- 岗位管理（udp_positionmgmt）
- 恢复账号（udp_account_recovery）
- 成交模型（opportunity_model）
- 扩展字段（udp_extend_field）
- 文件管理（sales_solution_file）
- 机构要素状态（org_factor）
- 案例库（case_library）
- 沟通分析（communication_analysis）
- 沟通总结（communication_summary）
- 沟通流程（communication_process）
- 沟通计划字段配置（communication_plan_field_set）
- 用户组管理（udp_usergroup）
- 画像配置（portrait_config）
- 知识库（manage_knglib）
- 竞争对手管理（competitor）
- 线索列表（lead_list）
- 线索状态（lead_status）
- 职级管理（udp_position）
- 联系人字段（contact_manage）
- 联系人角色（contact_role）
- 能力模型（sales_ability_model）
- 角色权限（core_rolepermission）
- 访前准备（sales_before_visit）
- 访后分析（sales_after_visit）
- 赋能教练（coach_configuration）
- 违规检测（violation_detection）
- 部门管理（udp_department）
- 风险预警（risk_notice）

## 看板/报表类页面明细（本次重抓核心发现）

- **运营看板 ops_dashboard**：赋能驾驶舱。概览（参与赋能次数/人数/时长）+ 完成赋能次数分布/趋势 + 赋能阶段完成次数分布 + 赋能时长分布/趋势 + 九宫格人才定位（起步型/野路子/透支型/机械型/稳定型/亮点型/调向型/标杆型/突破型）+ 按人列表（姓名/部门/岗位/九宫格/完成次数/时长）；支持按部门/日期筛选与 Excel 导出（运营看板_yyyyMMdd.xlsx）
- **指挥舱 commander**：实时沟通看板（抽屉式）+ 客户追踪器（我的关注）
- **团队报告 team_report**：周报/月报/季报/年报四档
- **排行榜**：任务达成排行榜 + 能力评估排行榜 + 团队违规率分布（违规率/违规沟通次数/总沟通次数）+ 团队能力评估雷达图
- **业务洞察 insight**：洞察分类/洞察模板配置 + 客户洞察 Tab（客户详情内）+ 关键洞察/主要障碍

## 其他路由（121 条中非命名管理页部分，含销售端/H5/Electron）

ability_model、account、add_inner_contact、add_outer_contact、arrange_visit、arrange_visit2、ask-ai、ask_ai、ask_ai_faq、business_insight、category、category/list/:id、coach_config、coach_cyclical_page、commodity、communication_analysis、communication_plan、communication_process、communication_summary、competitor、contact_field、contact_role、customer、customer_field_set、customer_list、customer_status、customer_type、department、doc、download、dummy_cardmeet、dummy_window、employee、extendfield、global_config、hide_window、home、info_collection、insight、insight_category、insight_template、knowledge_repository、lead、lead_field、lead_list、lead_status、library、meet、meet_setting、meeting_summary_notification、opportunity、opportunity_field_settings、ops_dashboard、org_factor、performance、person、plan、portrait_config、position、post_analysis、pre_prepare、product_type、rank、record、report、risk、role、router、scenario_based_coping_model、setting、task_model、teamSetting、transaction_model、upgrade、usage、usergroup、violation_detection、visit_detail、visit_notification、workbench、workbench-h5