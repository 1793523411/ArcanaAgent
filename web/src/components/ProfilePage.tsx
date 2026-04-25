import { useState, useEffect } from "react";
import { userApi } from "../api";
import { useToast } from "./Toast";
import type { UserProfile, UpdateProfileRequest } from "../types";

export default function ProfilePage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editForm, setEditForm] = useState<UpdateProfileRequest>({});
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      setLoading(true);
      const data = await userApi.getProfile();
      setProfile(data);
      // 初始化编辑表单数据
      setEditForm({
        nickname: data.nickname || "",
        email: data.email || "",
        phone: data.phone || "",
        bio: data.bio || "",
      });
    } catch (error) {
      toast({
        title: "加载失败",
        description: "无法获取用户资料，请稍后重试",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSubmitting(true);
      const updatedProfile = await userApi.updateProfile(editForm);
      setProfile(updatedProfile);
      setIsEditModalOpen(false);
      toast({
        title: "更新成功",
        description: "个人资料已更新",
      });
    } catch (error) {
      toast({
        title: "更新失败",
        description: error instanceof Error ? error.message : "未知错误，请稍后重试",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-lg">加载中...</div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-lg text-red-500">加载用户资料失败，请刷新重试</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-3xl rounded-lg bg-white p-8 shadow-md">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-3xl font-bold text-gray-900">个人资料</h1>
          <button
            onClick={() => setIsEditModalOpen(true)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
          >
            编辑资料
          </button>
        </div>
        
        {/* 头像区域 */}
        <div className="mb-8 flex items-center gap-6">
          <div className="h-24 w-24 overflow-hidden rounded-full bg-gray-200">
            {profile.avatar ? (
              <img 
                src={profile.avatar} 
                alt="用户头像" 
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-2xl font-bold text-gray-500">
                {profile.nickname?.charAt(0) || profile.username?.charAt(0) || "U"}
              </div>
            )}
          </div>
          <div>
            <h2 className="text-xl font-semibold">{profile.nickname || profile.username}</h2>
            <p className="text-gray-500">{profile.email}</p>
          </div>
        </div>

        {/* 基础信息展示区 */}
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-600">用户名</label>
              <p className="mt-1 rounded-md border border-gray-200 bg-gray-50 p-2 text-gray-900">
                {profile.username}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600">昵称</label>
              <p className="mt-1 rounded-md border border-gray-200 bg-gray-50 p-2 text-gray-900">
                {profile.nickname || "未设置"}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600">邮箱</label>
              <p className="mt-1 rounded-md border border-gray-200 bg-gray-50 p-2 text-gray-900">
                {profile.email || "未设置"}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600">手机号</label>
              <p className="mt-1 rounded-md border border-gray-200 bg-gray-50 p-2 text-gray-900">
                {profile.phone || "未设置"}
              </p>
            </div>
          </div>

          {profile.bio && (
            <div>
              <label className="block text-sm font-medium text-gray-600">个人简介</label>
              <p className="mt-1 rounded-md border border-gray-200 bg-gray-50 p-2 text-gray-900 min-h-[80px]">
                {profile.bio}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 编辑弹窗 */}
      {isEditModalOpen && profile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold text-gray-900">编辑个人资料</h2>
              <button
                onClick={() => setIsEditModalOpen(false)}
                className="text-gray-400 hover:text-gray-600"
                disabled={submitting}
              >
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleEditSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">昵称</label>
                <input
                  type="text"
                  value={editForm.nickname || ""}
                  onChange={(e) => setEditForm({ ...editForm, nickname: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={submitting}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
                <input
                  type="email"
                  value={editForm.email || ""}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={submitting}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">手机号</label>
                <input
                  type="tel"
                  value={editForm.phone || ""}
                  onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={submitting}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">个人简介</label>
                <textarea
                  value={editForm.bio || ""}
                  onChange={(e) => setEditForm({ ...editForm, bio: e.target.value })}
                  rows={4}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={submitting}
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsEditModalOpen(false)}
                  className="flex-1 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                  disabled={submitting}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300 transition-colors"
                  disabled={submitting}
                >
                  {submitting ? "提交中..." : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
