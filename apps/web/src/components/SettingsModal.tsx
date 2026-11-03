import { Input } from './ui/Input';
import { Field, Label } from './ui/Field';
import React, { useState } from 'react';
import { ModalBody } from './Modal';
import { KeyRound, Save, RefreshCw, Check, ShieldAlert, Palette } from 'lucide-react';
import { AppConfig, SourceIconsConfig } from '../types';

interface SettingsModalProps {
  config: AppConfig;
  onChangePassword?: (oldPass: string, newPass: string) => Promise<boolean>;
  onUpdateSettings?: (settings: Partial<AppConfig['settings']>) => Promise<boolean>;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  config,
  onChangePassword,
  onUpdateSettings,
}) => {
  // Password modification state
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwdMsg, setPwdMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isUpdatingPwd, setIsUpdatingPwd] = useState(false);

  // Source Icons state
  const currentIcons: SourceIconsConfig = config.settings?.sourceIcons || {};
  const [customIcon, setCustomIcon] = useState(currentIcons.custom ?? '🖥️');
  const [filterIcon, setFilterIcon] = useState(currentIcons.filter ?? '✨');
  const [remoteIcon, setRemoteIcon] = useState(currentIcons.remote ?? '⚡️');
  const [iconMsg, setIconMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isUpdatingIcons, setIsUpdatingIcons] = useState(false);

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword) {
      setPwdMsg({ type: 'error', text: '新密码不能为空' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwdMsg({ type: 'error', text: '两次输入的新密码不一致' });
      return;
    }

    setIsUpdatingPwd(true);
    setPwdMsg(null);
    try {
      if (onChangePassword) {
        const ok = await onChangePassword(oldPassword, newPassword);
        if (ok) {
          setPwdMsg({ type: 'success', text: '管理密码修改成功！' });
          setOldPassword('');
          setNewPassword('');
          setConfirmPassword('');
        } else {
          setPwdMsg({ type: 'error', text: '密码修改失败，请检查旧密码是否正确' });
        }
      }
    } catch (err: any) {
      setPwdMsg({ type: 'error', text: err.message || '修改密码失败' });
    } finally {
      setIsUpdatingPwd(false);
    }
  };

  const handleSaveIcons = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdatingIcons(true);
    setIconMsg(null);
    try {
      if (onUpdateSettings) {
        const ok = await onUpdateSettings({
          sourceIcons: {
            custom: customIcon.trim() || '🖥️',
            filter: filterIcon.trim() || '✨',
            remote: remoteIcon.trim() || '⚡️',
          },
        });
        if (ok) {
          setIconMsg({ type: 'success', text: '图标配置已成功保存并立即生效！' });
        } else {
          setIconMsg({ type: 'error', text: '保存失败，请检查网络或控制台错误' });
        }
      }
    } catch (err: any) {
      setIconMsg({ type: 'error', text: err.message || '保存图标配置失败' });
    } finally {
      setIsUpdatingIcons(false);
    }
  };

  return (
    <ModalBody className="gap-6">

      {/* Source and Group Icons Configuration */}
      <div className="space-y-3 pb-5 border-b border-ui-divider">
        <div className="flex items-center gap-2">
          <Palette className="w-4 h-4 text-ui-accent" />
          <h4 className="text-xs font-bold text-ui-text">订阅源与策略组图标配置</h4>
        </div>

        <p className="text-xs text-ui-muted leading-relaxed">
          设置用于区分源类型的前缀图标（自建、过滤源、机场订阅）。保存后将实时自动同步所有策略组命名及引用。
        </p>

        {iconMsg && (
          <div
            className={`p-2.5 rounded-xl text-xs flex items-center gap-2 ${iconMsg.type === 'success'
              ? 'bg-[#EAF2EE] border border-[#D5E5DE] text-[#367A68]'
              : 'bg-[#FDF2F0] border border-[#F2D6D3] text-[#A8483B]'
              }`}
          >
            {iconMsg.type === 'success' ? <Check className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
            <span>{iconMsg.text}</span>
          </div>
        )}

        <form onSubmit={handleSaveIcons} className="space-y-3">
          <div className="grid grid-cols-3 gap-2.5">
            <Field>
              <Label className="block">
                自建/独立源
              </Label>
              <div className="flex items-center gap-1.5">
                <Input
                  type="text"
                  required
                  placeholder="🖥️"
                  value={customIcon}
                  onChange={e => setCustomIcon(e.target.value)}
                  className="w-full font-mono"
                />
              </div>
              <span className="text-[10px] text-ui-muted mt-0.5 block">例如: 🖥️</span>
            </Field>
            <Field>
              <Label className="block">
                过滤源
              </Label>
              <div className="flex items-center gap-1.5">
                <Input
                  type="text"
                  required
                  placeholder="✨"
                  value={filterIcon}
                  onChange={e => setFilterIcon(e.target.value)}
                  className="w-full font-mono"
                />
              </div>
              <span className="text-[10px] text-ui-muted mt-0.5 block">例如: ✨</span>
            </Field>
            <Field>
              <Label className="block">
                机场订阅
              </Label>
              <div className="flex items-center gap-1.5">
                <Input
                  type="text"
                  required
                  placeholder="⚡️"
                  value={remoteIcon}
                  onChange={e => setRemoteIcon(e.target.value)}
                  className="w-full font-mono"
                />
              </div>
              <span className="text-[10px] text-ui-muted mt-0.5 block">例如: ⚡️</span>
            </Field>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={isUpdatingIcons}
              className="px-3 py-1.5 text-xs font-medium text-ui-accent bg-ui-accent-soft hover:bg-[#F3DDD3] border border-[#F3DDD3] rounded-xl transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              <Save className="w-3.5 h-3.5" />
              {isUpdatingIcons ? '保存中...' : '保存图标配置'}
            </button>
          </div>
        </form>
      </div>

      {/* Change Admin Password */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-ui-accent" />
          <h4 className="text-xs font-bold text-ui-text">修改管理员登录密码</h4>
        </div>

        <p className="text-xs text-ui-muted">
          修改用于登录 SubOne 控制台的管理员密码。
        </p>

        {pwdMsg && (
          <div
            className={`p-2.5 rounded-xl text-xs flex items-center gap-2 ${pwdMsg.type === 'success'
              ? 'bg-[#EAF2EE] border border-[#D5E5DE] text-[#367A68]'
              : 'bg-[#FDF2F0] border border-[#F2D6D3] text-[#A8483B]'
              }`}
          >
            {pwdMsg.type === 'success' ? <Check className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
            <span>{pwdMsg.text}</span>
          </div>
        )}

        <form onSubmit={handleUpdatePassword} className="space-y-3">
          {config.settings.adminPassword && (
            <Field>
              <Label className="block">
                原登录密码
              </Label>
              <Input
                type="password"
                placeholder="请输入当前密码"
                value={oldPassword}
                onChange={e => setOldPassword(e.target.value)}
                className="w-full font-mono"
              />
            </Field>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <Field>
              <Label className="block">
                新登录密码
              </Label>
              <Input
                type="password"
                required
                placeholder="输入新密码"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                className="w-full font-mono"
              />
            </Field>
            <Field>
              <Label className="block">
                确认新密码
              </Label>
              <Input
                type="password"
                required
                placeholder="再次输入新密码"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                className="w-full font-mono"
              />
            </Field>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={isUpdatingPwd || !newPassword}
              className="px-3.5 py-1.5 text-xs font-medium text-ui-accent bg-ui-accent-soft hover:bg-[#F3DDD3] border border-[#F3DDD3] rounded-xl transition-colors disabled:opacity-50"
            >
              {isUpdatingPwd ? '更新中...' : '更新密码'}
            </button>
          </div>
        </form>
      </div>
    </ModalBody>
  );
};

